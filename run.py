#!/usr/bin/env python3
import argparse
import os
import socket
import subprocess
import sys
import webbrowser
import threading
import time
from pathlib import Path

# ── Settings ───────────────────────────────────────────────────────────────────
PORT = 8001

# True  — ContentChecker opens only on this computer (http://localhost:PORT).
# False — also from other devices in the same network (phone, TV, another
#         computer): http://<IP of this computer>:PORT, printed at startup.
#         They can only open folders that were opened on this computer since
#         the start (or the ones listed in LAN_ROOTS).
LOCAL_ONLY = True

# Optional: folders other devices may open even if they weren't opened here,
# e.g. ["/Volumes/Media"]. Files outside them are never served to anyone.
LAN_ROOTS: list[str] = []
# ───────────────────────────────────────────────────────────────────────────────

BASE_DIR = Path(__file__).parent


def lan_ip() -> str:
    """This computer's address in the local network (no packets are sent)."""
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
            s.connect(("10.255.255.255", 1))
            return s.getsockname()[0]
    except OSError:
        return "<IP этого компьютера>"


def open_browser():
    time.sleep(1.5)
    webbrowser.open(f"http://localhost:{PORT}")


if __name__ == "__main__":
    # Command-line flags override the settings above (handy outside PyCharm)
    parser = argparse.ArgumentParser(description="ContentChecker")
    parser.add_argument("--lan", action="store_true",
                        help="доступ с других устройств в сети (как LOCAL_ONLY = False)")
    parser.add_argument("--root", action="append", default=[], metavar="PATH",
                        help="разрешённая папка (как LAN_ROOTS, можно повторять)")
    args = parser.parse_args()
    local_only = LOCAL_ONLY and not args.lan
    roots = LAN_ROOTS + args.root

    env = dict(os.environ)
    if not local_only:
        env["CC_LAN"] = "1"
    if roots:
        env["CC_ALLOWED_ROOTS"] = os.pathsep.join(roots)

    if local_only:
        print(f"ContentChecker: http://localhost:{PORT} (только на этом компьютере)")
    else:
        print(f"ContentChecker: http://localhost:{PORT}, с других устройств: http://{lan_ip()}:{PORT}")

    threading.Thread(target=open_browser, daemon=True).start()
    subprocess.run([
        sys.executable, "-m", "uvicorn", "app:app",
        "--host", "127.0.0.1" if local_only else "0.0.0.0",
        "--port", str(PORT),
        "--reload",
    ], cwd=BASE_DIR, env=env)
