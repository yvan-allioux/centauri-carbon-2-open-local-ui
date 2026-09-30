import os

PRINTER_IP = os.environ.get("PRINTER_IP", "")
MQTT_PORT = int(os.environ.get("MQTT_PORT", "1883"))

PRINTER_SN = os.environ.get("PRINTER_SN", "")
MQTT_USER = os.environ.get("MQTT_USER", "elegoo")
MQTT_PASS = os.environ.get("MQTT_PASS", "123456")
CLIENT_ID = os.environ.get("CLIENT_ID", "ecc2_ui")

CAMERA_URL = os.environ.get("CAMERA_URL", f"http://{PRINTER_IP}:8080/?action=stream")

WEB_HOST = os.environ.get("WEB_HOST", "0.0.0.0")
WEB_PORT = int(os.environ.get("WEB_PORT", "8080"))

HEARTBEAT_INTERVAL = float(os.environ.get("HEARTBEAT_INTERVAL", "15"))
COMMAND_TIMEOUT = float(os.environ.get("COMMAND_TIMEOUT", "10"))
