#!/usr/bin/env python3
import subprocess
import sys
import webbrowser
import threading
import time

PORT = 8000

def open_browser():
    time.sleep(1.5)
    webbrowser.open(f"http://localhost:{PORT}")

if __name__ == "__main__":
    threading.Thread(target=open_browser, daemon=True).start()
    subprocess.run([
        sys.executable, "-m", "uvicorn", "app:app",
        "--host", "0.0.0.0",
        "--port", str(PORT),
        "--reload",
    ])
