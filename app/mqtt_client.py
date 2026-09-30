import copy
import itertools
import json
import logging
import os
import threading
import time

import paho.mqtt.client as mqtt

log = logging.getLogger("cc2.mqtt")


def deep_merge(base, delta):
    for key, value in delta.items():
        if isinstance(value, dict) and isinstance(base.get(key), dict):
            deep_merge(base[key], value)
        else:
            base[key] = value
    return base


class PrinterClient:
    def __init__(
        self,
        host,
        port,
        sn,
        user,
        password,
        client_id="ecc2_ui",
        heartbeat_interval=15.0,
        command_timeout=10.0,
    ):
        self.host = host
        self.port = port
        self.client_id = f"{client_id}_{os.urandom(2).hex()}"[:10]
        self.heartbeat_interval = heartbeat_interval
        self.command_timeout = command_timeout

        base = f"elegoo/{sn}"
        self.topic_status = f"{base}/api_status"
        self.topic_request = f"{base}/{self.client_id}/api_request"
        self.topic_response = f"{base}/{self.client_id}/api_response"
        self.topic_register = f"{base}/api_register"
        self.topic_register_response = f"{base}/{self.client_id}/register_response"

        self.state = {}
        self.attributes = {}
        self._state_lock = threading.Lock()

        self._seq = itertools.count(1)
        self._pending = {}
        self._pending_lock = threading.Lock()

        self._connected = threading.Event()
        self._registered = threading.Event()
        self._stop = threading.Event()

        self.client = mqtt.Client(
            mqtt.CallbackAPIVersion.VERSION2,
            client_id=self.client_id,
            protocol=mqtt.MQTTv311,
        )
        self.client.username_pw_set(user, password)
        self.client.reconnect_delay_set(min_delay=1, max_delay=30)
        self.client.on_connect = self._on_connect
        self.client.on_disconnect = self._on_disconnect
        self.client.on_message = self._on_message

    def start(self):
        self.client.connect_async(self.host, self.port, keepalive=30)
        self.client.loop_start()
        threading.Thread(target=self._heartbeat_loop, name="heartbeat", daemon=True).start()

    def stop(self):
        self._stop.set()
        try:
            self.client.loop_stop()
            self.client.disconnect()
        except Exception:
            pass

    def is_connected(self):
        return self._connected.is_set()

    def is_registered(self):
        return self._registered.is_set()

    def get_state(self):
        with self._state_lock:
            return copy.deepcopy(self.state)

    def refresh(self):
        return self.command(1002)

    def command(self, method, params=None, timeout=None):
        if not self._registered.is_set():
            raise RuntimeError("client not registered with the printer")
        seq = next(self._seq)
        entry = {"event": threading.Event(), "result": None}
        with self._pending_lock:
            self._pending[seq] = entry
        body = {"id": seq, "method": int(method), "params": params or {}}
        self.client.publish(self.topic_request, json.dumps(body))
        got = entry["event"].wait(timeout if timeout is not None else self.command_timeout)
        with self._pending_lock:
            self._pending.pop(seq, None)
        if not got:
            raise TimeoutError(f"no response for method {method}")
        result = entry["result"] or {}
        err = (result.get("result") or {}).get("error_code", 0)
        if err:
            raise RuntimeError(f"printer error {err} (method {method})")
        return result

    def _on_connect(self, client, userdata, flags, reason_code, properties):
        log.info("MQTT connected (rc=%s)", reason_code)
        self._connected.set()
        self._registered.clear()
        client.subscribe(
            [
                (self.topic_status, 0),
                (self.topic_response, 0),
                (self.topic_register_response, 0),
            ]
        )
        client.publish(
            self.topic_register,
            json.dumps({"client_id": self.client_id, "request_id": self.client_id}),
        )

    def _on_disconnect(self, client, userdata, disconnect_flags, reason_code, properties):
        log.warning("MQTT disconnected (rc=%s)", reason_code)
        self._connected.clear()
        self._registered.clear()

    def _on_message(self, client, userdata, msg):
        try:
            data = json.loads(msg.payload.decode())
        except Exception:
            return
        topic = msg.topic

        if topic == self.topic_register_response:
            if isinstance(data, dict) and str(data.get("error", "")).lower() == "ok":
                self._registered.set()
                log.info("registered with the printer")
                try:
                    self.command(1001)
                    self.command(1002)
                except Exception as exc:
                    log.warning("initial refresh: %s", exc)
            return

        if topic == self.topic_status:
            delta = data.get("result", data) if isinstance(data, dict) else data
            if isinstance(delta, dict):
                with self._state_lock:
                    deep_merge(self.state, delta)
            return

        if topic == self.topic_response:
            if isinstance(data, dict) and data.get("type") == "PONG":
                return
            seq = data.get("id")
            with self._pending_lock:
                entry = self._pending.get(seq)
            if entry:
                entry["result"] = data
                entry["event"].set()

    def _heartbeat_loop(self):
        while not self._stop.is_set():
            if self._connected.is_set():
                self.client.publish(self.topic_request, json.dumps({"type": "PING"}))
            self._stop.wait(self.heartbeat_interval)
