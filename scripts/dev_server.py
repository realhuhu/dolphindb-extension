"""Start an isolated local JupyterLab for manual extension QA."""

import secrets
import socket
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
QA = ROOT / ".qa"
with socket.socket() as probe:
    probe.settimeout(1)
    if probe.connect_ex(("127.0.0.1", 8890)) == 0:
        raise SystemExit("Port 8890 is already in use. Stop the existing server before starting another.")
QA.mkdir(exist_ok=True)
(QA / "workspace").mkdir(exist_ok=True)
token = secrets.token_hex(24)
(QA / "token").write_text(token, encoding="utf-8")
config = QA / "jupyter_server_config.py"
config.write_text(
    "c.ServerApp.ip = '127.0.0.1'\n"
    "c.ServerApp.port = 8890\n"
    "c.ServerApp.port_retries = 0\n"
    "c.ServerApp.open_browser = False\n"
    "c.ServerApp.jpserver_extensions = {'dolphindb_extension': True}\n"
    f"c.ServerApp.root_dir = {str(QA / 'workspace')!r}\n"
    f"c.DolphinDBExtensionApp.connections_dir = {str(QA / 'connections')!r}\n"
    f"c.LabServerApp.user_settings_dir = {str(QA / 'settings')!r}\n"
    f"c.IdentityProvider.token = {token!r}\n",
    encoding="utf-8",
)
with (QA / "jupyter.log").open("w", encoding="utf-8") as log:
    process = subprocess.Popen(
        [sys.executable, "-m", "jupyterlab", "--config", str(config)],
        cwd=ROOT,
        stdout=log,
        stderr=subprocess.STDOUT,
        creationflags=subprocess.CREATE_NO_WINDOW if sys.platform == "win32" else 0,
    )
(QA / "pid").write_text(str(process.pid), encoding="utf-8")
print(f"JupyterLab started on http://127.0.0.1:8890/lab (PID {process.pid}).")
print("Local login token: .qa/token; server log: .qa/jupyter.log")
