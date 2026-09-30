import logging
import queue
import threading

import requests

log = logging.getLogger("cc2.camera")

SOI = b"\xff\xd8"
EOI = b"\xff\xd9"


class Subscriber:
    def __init__(self):
        self.queue = queue.Queue(maxsize=2)

    def push(self, frame):
        try:
            self.queue.put_nowait(frame)
        except queue.Full:
            try:
                self.queue.get_nowait()
            except queue.Empty:
                pass
            try:
                self.queue.put_nowait(frame)
            except queue.Full:
                pass

    def get(self, timeout=15):
        return self.queue.get(timeout=timeout)


class CameraBroadcaster:
    """Ouvre une seule connexion au flux MJPEG et la redistribue (fan-out).

    Contourne le CORS et evite de multiplier les clients sur la camera.
    """

    def __init__(self, url):
        self.url = url
        self._subs = set()
        self._lock = threading.Lock()
        self._stop = threading.Event()
        self._thread = None
        self._last_frame = None

    def start(self):
        if self._thread and self._thread.is_alive():
            return
        self._stop.clear()
        self._thread = threading.Thread(target=self._run, name="camera", daemon=True)
        self._thread.start()

    def stop(self):
        self._stop.set()

    def subscribe(self):
        sub = Subscriber()
        with self._lock:
            if self._last_frame is not None:
                sub.push(self._last_frame)
            self._subs.add(sub)
        return sub

    def unsubscribe(self, sub):
        with self._lock:
            self._subs.discard(sub)

    def is_alive(self):
        return self._thread is not None and self._thread.is_alive() and self._last_frame is not None

    def _run(self):
        while not self._stop.is_set():
            try:
                self._read_stream()
            except Exception as exc:
                log.warning("flux camera: %s", exc)
            self._stop.wait(2)

    def _read_stream(self):
        with requests.get(self.url, stream=True, timeout=(5, 15)) as resp:
            resp.raise_for_status()
            buf = b""
            for chunk in resp.iter_content(chunk_size=8192):
                if self._stop.is_set():
                    return
                if not chunk:
                    continue
                buf += chunk
                buf = self._extract_frames(buf)
                if len(buf) > 2_000_000:
                    buf = buf[-65536:]

    def _extract_frames(self, buf):
        while True:
            start = buf.find(SOI)
            if start == -1:
                return buf[-1:] if buf.endswith(b"\xff") else b""
            end = buf.find(EOI, start + 2)
            if end == -1:
                return buf[start:]
            frame = buf[start : end + 2]
            buf = buf[end + 2 :]
            self._broadcast(frame)

    def _broadcast(self, frame):
        with self._lock:
            self._last_frame = frame
            subs = list(self._subs)
        for sub in subs:
            sub.push(frame)
