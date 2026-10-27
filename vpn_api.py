"""
WireGuard Chrome Manager - Local API

Runs WireGuard entirely in userspace via wireproxy and exposes it as a local
SOCKS5 proxy. No network adapter or system route is created, so nothing on the
machine is tunneled except what Chrome (through the extension) sends to the
proxy.
"""

import json
import logging
import os
import re
import socket
import ssl
import subprocess
import threading
import time
from pathlib import Path

from flask import Flask, jsonify, request
from flask_cors import CORS

# ---------------------------------------------------------------- paths
# Use PROGRAMDATA because this runs as a Windows service (SYSTEM account).
# APPDATA under SYSTEM resolves to a restricted systemprofile path the user
# can't browse; PROGRAMDATA is the standard machine-wide location.
_BASE = os.environ.get("PROGRAMDATA") or os.environ.get("APPDATA") or str(Path.home())
APP_DIR = Path(_BASE) / "wg-chrome-manager"
PROFILES_DIR = APP_DIR / "profiles"
STATE_FILE = APP_DIR / "state.json"
ACTIVE_CONF = APP_DIR / "wireproxy.conf"
LOG_FILE = APP_DIR / "wireproxy.log"
HERE = Path(__file__).resolve().parent
WIREPROXY_CANDIDATES = [HERE / "wireproxy.exe", APP_DIR / "wireproxy.exe"]

SOCKS_HOST = "127.0.0.1"
SOCKS_PORT = 25344

APP_DIR.mkdir(parents=True, exist_ok=True)
PROFILES_DIR.mkdir(parents=True, exist_ok=True)

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("vpn_api")


# ---------------------------------------------------------------- state
DEFAULT_STATE = {"active_profile": None}


def load_state() -> dict:
    if not STATE_FILE.exists():
        return dict(DEFAULT_STATE)
    try:
        data = json.loads(STATE_FILE.read_text(encoding="utf-8"))
        return {**DEFAULT_STATE, **{k: v for k, v in data.items() if k in DEFAULT_STATE}}
    except Exception as e:
        log.warning("state load failed: %s", e)
        return dict(DEFAULT_STATE)


def save_state(state: dict):
    STATE_FILE.write_text(json.dumps(state, indent=2), encoding="utf-8")


# ---------------------------------------------------------------- conf
def build_active_conf(template: str) -> str:
    """Strip any proxy sections from the profile and append our SOCKS5 listener."""
    cleaned = []
    skip = False
    for line in template.splitlines():
        header = re.match(r"^\s*\[([^\]]+)\]\s*$", line)
        if header:
            skip = header.group(1).strip().lower() not in ("interface", "peer")
        if not skip:
            cleaned.append(line)
    body = "\n".join(cleaned).rstrip()
    return f"{body}\n\n[Socks5]\nBindAddress = {SOCKS_HOST}:{SOCKS_PORT}\n"


def write_active_conf():
    state = load_state()
    if not state["active_profile"]:
        raise RuntimeError("No active profile selected")
    profile_path = PROFILES_DIR / state["active_profile"]
    if not profile_path.exists():
        raise RuntimeError(f"Profile file missing: {profile_path}")
    ACTIVE_CONF.write_text(build_active_conf(profile_path.read_text(encoding="utf-8")), encoding="utf-8")


# ---------------------------------------------------------------- tunnel
_proc: subprocess.Popen | None = None
_lock = threading.RLock()


def wireproxy_exe() -> Path | None:
    for p in WIREPROXY_CANDIDATES:
        if p.exists():
            return p
    return None


def port_open(host=SOCKS_HOST, port=SOCKS_PORT, timeout=0.3) -> bool:
    try:
        with socket.create_connection((host, port), timeout=timeout):
            return True
    except OSError:
        return False


def tunnel_running() -> bool:
    return _proc is not None and _proc.poll() is None


def tunnel_stop():
    global _proc
    with _lock:
        if _proc is not None and _proc.poll() is None:
            _proc.terminate()
            try:
                _proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                _proc.kill()
        _proc = None
        # A wireproxy left over from a crashed API instance still holds the port.
        for _ in range(20):
            if not port_open():
                return
            subprocess.run(["taskkill", "/F", "/IM", "wireproxy.exe"], capture_output=True)
            time.sleep(0.25)


def tunnel_start():
    global _proc
    exe = wireproxy_exe()
    if not exe:
        raise RuntimeError("wireproxy.exe not found (put it in the project folder)")
    with _lock:
        tunnel_stop()
        write_active_conf()
        logf = open(LOG_FILE, "w", encoding="utf-8")
        _proc = subprocess.Popen(
            [str(exe), "-c", str(ACTIVE_CONF)],
            stdout=logf, stderr=subprocess.STDOUT,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
        for _ in range(40):
            if _proc.poll() is not None:
                break
            if port_open():
                return
            time.sleep(0.25)
        tail = LOG_FILE.read_text(encoding="utf-8", errors="ignore")[-400:].strip()
        tunnel_stop()
        raise RuntimeError(f"wireproxy could not be started: {tail or 'unknown error'}")


def restart_if_connected():
    if tunnel_running():
        tunnel_start()


# ---------------------------------------------------------------- health
def _socks5_connect(host: str, port: int, timeout: float) -> socket.socket:
    s = socket.create_connection((SOCKS_HOST, SOCKS_PORT), timeout=timeout)
    s.sendall(b"\x05\x01\x00")
    if s.recv(2) != b"\x05\x00":
        raise OSError("SOCKS5 greeting rejected")
    h = host.encode()
    s.sendall(b"\x05\x01\x00\x03" + bytes([len(h)]) + h + port.to_bytes(2, "big"))
    rep = s.recv(4)
    if len(rep) < 4 or rep[1] != 0:
        raise OSError(f"SOCKS5 connect failed (code {rep[1] if len(rep) > 1 else '?'})")
    addr_len = {1: 4, 4: 16}.get(rep[3])
    if addr_len is None:
        addr_len = s.recv(1)[0]
    s.recv(addr_len + 2)
    return s


def tunnel_check(timeout: float = 8.0) -> dict:
    """Fetch Cloudflare's trace through the tunnel to prove the handshake works."""
    host = "www.cloudflare.com"
    raw = _socks5_connect(host, 443, timeout)
    with ssl.create_default_context().wrap_socket(raw, server_hostname=host) as s:
        s.sendall(f"GET /cdn-cgi/trace HTTP/1.1\r\nHost: {host}\r\nConnection: close\r\n\r\n".encode())
        data = b""
        while chunk := s.recv(4096):
            data += chunk
    body = data.split(b"\r\n\r\n", 1)[-1].decode(errors="ignore")
    info = dict(line.split("=", 1) for line in body.splitlines() if "=" in line)
    return {"ip": info.get("ip"), "country": info.get("loc")}


# ---------------------------------------------------------------- profiles
SAFE_NAME = re.compile(r"[^A-Za-z0-9._-]")


def sanitize_name(name: str) -> str:
    name = name.strip()
    if not name.lower().endswith(".conf"):
        name += ".conf"
    base = SAFE_NAME.sub("_", name)
    if base in (".conf", ""):
        raise ValueError("Invalid profile name")
    return base


def list_profiles() -> list[str]:
    return sorted(p.name for p in PROFILES_DIR.glob("*.conf"))


# ---------------------------------------------------------------- flask
app = Flask(__name__)
# Only the extension may read responses; web pages must not see profiles/keys.
CORS(app, origins=[r"chrome-extension://.*"])


def status_payload() -> dict:
    state = load_state()
    return {
        "connected": tunnel_running(),
        "active_profile": state["active_profile"],
        "profiles": list_profiles(),
        "wireproxy_installed": wireproxy_exe() is not None,
        "socks": {"host": SOCKS_HOST, "port": SOCKS_PORT},
    }


@app.route("/api/status", methods=["GET"])
def api_status():
    return jsonify(status_payload())


@app.route("/api/profiles", methods=["POST"])
def api_add_profile():
    body = request.get_json(silent=True) or {}
    name = body.get("name")
    content = body.get("conf")
    if not name or not content:
        return jsonify({"error": "name and conf are required"}), 400
    if "[Interface]" not in content or "[Peer]" not in content:
        return jsonify({"error": "conf does not look like a WireGuard config"}), 400
    try:
        safe = sanitize_name(name)
    except ValueError as e:
        return jsonify({"error": str(e)}), 400
    (PROFILES_DIR / safe).write_text(content, encoding="utf-8")
    state = load_state()
    if body.get("activate") or not state["active_profile"]:
        state["active_profile"] = safe
        save_state(state)
    return jsonify({"ok": True, "name": safe, "status": status_payload()})


@app.route("/api/profiles/read", methods=["POST"])
def api_read_profile():
    body = request.get_json(silent=True) or {}
    name = body.get("name")
    if not name:
        return jsonify({"error": "name required"}), 400
    target = PROFILES_DIR / sanitize_name(name)
    if not target.exists():
        return jsonify({"error": "profile not found"}), 404
    return jsonify({"name": target.name, "conf": target.read_text(encoding="utf-8")})


@app.route("/api/profiles/delete", methods=["POST"])
def api_delete_profile():
    body = request.get_json(silent=True) or {}
    name = body.get("name")
    if not name:
        return jsonify({"error": "name required"}), 400
    safe = sanitize_name(name)
    target = PROFILES_DIR / safe
    if not target.exists():
        return jsonify({"error": "profile not found"}), 404
    state = load_state()
    target.unlink()
    if state["active_profile"] == safe:
        tunnel_stop()
        remaining = list_profiles()
        state["active_profile"] = remaining[0] if remaining else None
        save_state(state)
    return jsonify({"ok": True, "status": status_payload()})


@app.route("/api/profiles/activate", methods=["POST"])
def api_activate_profile():
    body = request.get_json(silent=True) or {}
    name = body.get("name")
    if not name:
        return jsonify({"error": "name required"}), 400
    safe = sanitize_name(name)
    if not (PROFILES_DIR / safe).exists():
        return jsonify({"error": "profile not found"}), 404
    state = load_state()
    state["active_profile"] = safe
    save_state(state)
    try:
        restart_if_connected()
    except Exception as e:
        return jsonify({"error": str(e), "status": status_payload()}), 500
    return jsonify({"ok": True, "status": status_payload()})


@app.route("/api/connect", methods=["POST"])
def api_connect():
    if not load_state()["active_profile"]:
        return jsonify({"error": "no active profile"}), 400
    try:
        tunnel_start()
    except Exception as e:
        return jsonify({"error": str(e), "status": status_payload()}), 500
    return jsonify({"ok": True, "status": status_payload()})


@app.route("/api/disconnect", methods=["POST"])
def api_disconnect():
    tunnel_stop()
    return jsonify({"ok": True, "status": status_payload()})


@app.route("/api/check", methods=["GET"])
def api_check():
    if not tunnel_running():
        return jsonify({"ok": False, "error": "tunnel not running"}), 409
    try:
        return jsonify({"ok": True, **tunnel_check()})
    except Exception as e:
        return jsonify({"ok": False, "error": f"The tunnel passes no traffic: {e}"}), 502


def shutdown():
    tunnel_stop()


def start_api():
    log.info("WG Chrome Manager API listening on http://127.0.0.1:5000 (SOCKS5 %s:%d)", SOCKS_HOST, SOCKS_PORT)
    app.run(host="127.0.0.1", port=5000, debug=False, use_reloader=False, threaded=True)


if __name__ == "__main__":
    try:
        start_api()
    finally:
        shutdown()
