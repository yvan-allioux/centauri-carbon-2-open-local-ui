import base64
import hashlib
import logging
import os
import queue

import requests
from flask import Flask, Response, jsonify, request

from . import config
from .camera import CameraBroadcaster
from .mqtt_client import PrinterClient

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s: %(message)s",
)
log = logging.getLogger("cc2.server")

app = Flask(__name__, static_folder="static", static_url_path="/static")

printer = PrinterClient(
    host=config.PRINTER_IP,
    port=config.MQTT_PORT,
    sn=config.PRINTER_SN,
    user=config.MQTT_USER,
    password=config.MQTT_PASS,
    client_id=config.CLIENT_ID,
    heartbeat_interval=config.HEARTBEAT_INTERVAL,
    command_timeout=config.COMMAND_TIMEOUT,
)

camera = CameraBroadcaster(config.CAMERA_URL)

ALLOWED_METHODS = {
    1001,  # GET_ATTRIBUTES
    1002,  # GET_BASIC_INFO
    1003,  # GET_MACHINE_STATUS
    1004,  # GET_FAN_INFO
    1005,  # GET_PRINTS_INFO
    1006,  # GET_HOME_STATUS
    1007,  # URGENT_STOP
    1020,  # START_PRINT
    1021,  # PAUSE_PRINT
    1022,  # STOP_PRINT
    1023,  # RESUME_PRINT
    1026,  # HOME_AXES
    1027,  # MOVE_AXES
    1028,  # SET_TEMPERATURE
    1029,  # SET_LIGHT
    1030,  # SET_FAN_SPEED
    1031,  # SET_PRINT_SPEED
    1036,  # GET_HISTORY_TASK
    1042,  # GET_LIVING_VIDEO_URL
    1044,  # GET_FILE_LIST
    1045,  # GET_FILE_THUMBNAIL
    1046,  # GET_FILE_DETAIL
    1047,  # DELETE_FILE
    1048,  # GET_CAPACITY
    2001,  # LOAD_FILAMENT
    2002,  # UNLOAD_FILAMENT
    2003,  # SET_FILAMENT_INFO
    2004,  # SET_AUTO_REFILL
    2005,  # GET_CANVAS_STATUS
}

UPLOAD_URL = f"http://{config.PRINTER_IP}:80/upload"


def _result(resp):
    return (resp or {}).get("result") or {}



@app.get("/")
def index():
    return app.send_static_file("index.html")


@app.get("/api/status")
def status():
    return jsonify(
        {
            "connected": printer.is_connected(),
            "registered": printer.is_registered(),
            "camera": camera.is_alive(),
            "state": printer.get_state(),
        }
    )


@app.post("/api/command")
def command():
    body = request.get_json(force=True, silent=True) or {}
    method = body.get("method")
    params = body.get("params") or {}
    try:
        method = int(method)
    except (TypeError, ValueError):
        return jsonify({"error": "method invalide"}), 400
    if method not in ALLOWED_METHODS:
        return jsonify({"error": f"method {method} non autorisee"}), 400
    try:
        result = printer.command(method, params)
    except Exception as exc:
        return jsonify({"error": str(exc)}), 502
    return jsonify(result or {})


@app.get("/api/info")
def info():
    try:
        return jsonify(_result(printer.command(1001)))
    except Exception as exc:
        return jsonify({"error": str(exc)}), 502


@app.get("/api/files")
def files():
    try:
        listing = _result(
            printer.command(1044, {"storage_media": "local", "offset": 0, "limit": 200})
        )
        storage = _result(printer.command(1048))
        return jsonify(
            {
                "files": listing.get("file_list", []),
                "total": listing.get("total", 0),
                "storage": storage,
            }
        )
    except Exception as exc:
        return jsonify({"error": str(exc)}), 502


@app.get("/api/files/thumbnail")
def thumbnail():
    name = request.args.get("name", "")
    media = request.args.get("storage", "local")
    if not name:
        return jsonify({"error": "parametre 'name' requis"}), 400
    try:
        result = _result(printer.command(1045, {"storage_media": media, "file_name": name}))
    except Exception as exc:
        return jsonify({"error": str(exc)}), 502
    encoded = result.get("thumbnail")
    if not encoded:
        return jsonify({"error": "pas de vignette"}), 404
    return Response(base64.b64decode(encoded), mimetype="image/png")


@app.get("/api/history")
def history():
    try:
        result = _result(printer.command(1036, {"page": 1, "page_size": 50}))
        return jsonify(
            {
                "tasks": result.get("history_task_list", []),
                "total": result.get("total", 0),
            }
        )
    except Exception as exc:
        return jsonify({"error": str(exc)}), 502


@app.get("/api/filament")
def filament():
    try:
        return jsonify(_result(printer.command(2005)))
    except Exception as exc:
        return jsonify({"error": str(exc)}), 502


@app.post("/api/upload")
def upload():
    file = request.files.get("file")
    if file is None or not file.filename:
        return jsonify({"error": "aucun fichier recu"}), 400
    name = os.path.basename(file.filename)
    try:
        name.encode("latin-1")
    except UnicodeEncodeError:
        return jsonify({"error": "nom de fichier non supporte (latin-1 requis)"}), 400
    data = file.read()
    if not data:
        return jsonify({"error": "fichier vide"}), 400
    headers = {
        "Content-Type": "application/octet-stream",
        "Content-Range": f"bytes 0-{len(data) - 1}/{len(data)}",
        "Accept": "application/json",
        "User-Agent": "ElegooLink/1.3.6",
        "X-File-Name": name,
        "X-File-MD5": hashlib.md5(data).hexdigest(),
        "X-Token": config.MQTT_PASS,
    }
    try:
        resp = requests.put(UPLOAD_URL, data=data, headers=headers, timeout=120)
    except Exception as exc:
        return jsonify({"error": str(exc)}), 502
    try:
        body = resp.json()
    except ValueError:
        body = {"http_status": resp.status_code}
    payload = {"filename": name, "printer": body}
    return jsonify(payload), (200 if resp.ok else 502)



@app.get("/api/stream")
def stream():
    sub = camera.subscribe()

    def generate():
        try:
            while True:
                try:
                    frame = sub.get(timeout=20)
                except queue.Empty:
                    continue
                yield (
                    b"--frame\r\nContent-Type: image/jpeg\r\nContent-Length: "
                    + str(len(frame)).encode()
                    + b"\r\n\r\n"
                    + frame
                    + b"\r\n"
                )
        except GeneratorExit:
            return
        finally:
            camera.unsubscribe(sub)

    return Response(
        generate(),
        mimetype="multipart/x-mixed-replace; boundary=frame",
    )


def main():
    printer.start()
    camera.start()
    log.info("UI sur http://%s:%s -> imprimante %s", config.WEB_HOST, config.WEB_PORT, config.PRINTER_IP)
    app.run(host=config.WEB_HOST, port=config.WEB_PORT, threaded=True)


if __name__ == "__main__":
    main()
