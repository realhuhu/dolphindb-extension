"""Document-owned DolphinDB sockets, retained when an editor/browser disconnects.

The official JavaScript SDK still encodes requests and decodes results. This broker
only recognizes the SDK's connect/print/result envelopes; it never evaluates or
deserializes DolphinDB values. Reattaching replays the original connect response,
so the SDK resumes the same server session without reconnecting or logging in again.
"""

from __future__ import annotations

import asyncio
import base64
import time
from datetime import datetime, timezone
from typing import Any
from uuid import uuid4

from tornado.websocket import WebSocketClosedError, websocket_connect

from .connections import ConnectionError
from .preferences import history_options

DOS_RESOURCE = "dolphindb-extension:dos-sessions"
MAX_HISTORY_BYTES = 8 * 1024 * 1024


def validated_history_options(value):
    try:
        return history_options(value)
    except ValueError:
        raise ConnectionError("DOS 历史设置无效。") from None


def timestamp():
    return datetime.now(timezone.utc).isoformat()


def document_path(value):
    if not isinstance(value, str) or not value.lower().endswith(".dos"):
        raise ConnectionError("请选择 DOS 文件。")
    if len(value) > 4096 or "\\" in value or any(ord(c) < 32 for c in value):
        raise ConnectionError("文件路径无效。")
    if value.startswith("/") or any(p in ("", ".", "..") for p in value.split("/")):
        raise ConnectionError("文件路径无效。")
    return value


class DosSession:
    def __init__(self, owner, path, profile, password):
        self.id = str(uuid4())
        self.owner = owner
        self.path = path
        self.profile = dict(profile)
        self.password = password
        self.upstream = None
        self.client = None
        self.client_ready = False
        self.reader = None
        self.handshake = None
        self.pending = None
        self.ready = asyncio.Event()
        self.ready.set()
        self.state = "starting"
        self.locked = False
        self.closed = False
        self.created = time.monotonic()
        self.history: list[dict[str, Any]] = []
        self.sequence = 0
        self.current_run = None
        self.history_entries = 20
        self.history_bytes = MAX_HISTORY_BYTES

    def configure_history(self, entries, budget):
        self.history_entries, self.history_bytes = entries, budget
        self.trim_history()

    def trim_history(self):
        self.history = self.history[-self.history_entries:]
        retained = sum(len(frame) for run in self.history for frame in run["frames"])
        while len(self.history) > 1 and retained > self.history_bytes:
            retained -= sum(map(len, self.history.pop(0)["frames"]))
        if self.history and retained > self.history_bytes:
            self.history[-1]["frames"] = []
            self.history[-1]["truncated"] = True

    def summary(self):
        return {
            "id": self.id,
            "path": self.path,
            "profile": {k: v for k, v in self.profile.items() if k != "rememberPassword"},
            "state": self.state,
            "locked": self.locked,
            "attached": self.client is not None,
            "executionCount": self.sequence,
        }

    async def attach(self, client):
        if self.closed:
            raise ConnectionError("会话已断开，请先关闭旧会话再重新运行。", 409)
        if self.client is not None:
            raise ConnectionError("此文件已在另一页面连接；请先关闭该页面。", 409)
        self.client = client
        self.client_ready = False
        try:
            if self.upstream is None:
                p = self.profile
                host = f"[{p['host']}]" if ":" in p["host"] else p["host"]
                self.upstream = await websocket_connect(
                    f"{'wss' if p['ssl'] else 'ws'}://{host}:{p['port']}/",
                    connect_timeout=p["timeout"],
                    max_message_size=64 * 1024 * 1024,
                )
                if self.closed:
                    self.upstream.close()
                    return
                self.reader = asyncio.create_task(self.read_messages())
        except Exception:
            self.close("无法连接 DolphinDB 服务器")
            raise ConnectionError("无法连接 DolphinDB 服务器。", 502) from None

    def detach(self, client):
        if self.client is client:
            self.client = None
            self.client_ready = False

    async def send(self, data):
        if self.closed or self.upstream is None:
            raise ConnectionError("会话已断开。", 409)
        data = data.encode() if isinstance(data, str) else data
        if len(data) > 16 * 1024 * 1024 or not data.startswith(b"API2 ") or b"\n" not in data:
            raise ConnectionError("无效或过大的 DolphinDB 请求。")
        command = data.split(b"\n", 1)[1]
        # A detached request must finish before a fresh SDK can use the socket.
        await self.ready.wait()
        if self.closed:
            raise ConnectionError("会话已断开。", 409)
        self.client_ready = True
        if command.startswith(b"connect\n") and self.handshake is not None:
            if self.client:
                await self.client.write_message(self.handshake, binary=True)
            return
        self.pending = "connect" if command.startswith(b"connect\n") else "rpc"
        if command.startswith(b"script\nline://"):
            script = command[len(b"script\n") :].decode("utf-8", errors="replace")
            location, _, code = script.partition("\n")
            self.sequence += 1
            self.locked = True
            self.state = "busy"
            self.current_run = {
                "id": self.sequence,
                "code": code[:200_000],
                "line": location[7:],
                "started": timestamp(),
                "finished": None,
                "status": "running",
                "frames": [],
                "truncated": False,
            }
            self.history.append(self.current_run)
            self.trim_history()
        self.ready.clear()
        try:
            await self.upstream.write_message(data, binary=True)
        except WebSocketClosedError:
            self.close("DolphinDB 连接已断开")
            raise ConnectionError("DolphinDB 连接已断开。", 409) from None

    async def read_messages(self):
        try:
            while not self.closed:
                data = await self.upstream.read_message()
                if data is None:
                    break
                data = data.encode() if isinstance(data, str) else data
                printed = data.startswith(b"MSG\n")
                if self.current_run is not None:
                    frame = base64.b64encode(data).decode("ascii")
                    if sum(len(f) for f in self.current_run["frames"]) + len(frame) <= self.history_bytes:
                        self.current_run["frames"].append(frame)
                    else:
                        self.current_run["truncated"] = True
                    self.trim_history()
                if not printed:
                    success = data.split(b"\n", 2)[1:2] == [b"OK"]
                    if self.pending == "connect" and success:
                        self.handshake = data
                        self.state = "idle"
                    if self.current_run is not None:
                        self.current_run["finished"] = timestamp()
                        self.current_run["status"] = "ok" if success else "error"
                        self.current_run = None
                        self.state = "idle"
                    self.pending = None
                client = self.client
                if client is not None and self.client_ready:
                    try:
                        await client.write_message(data, binary=True)
                    except WebSocketClosedError:
                        self.detach(client)
                if not printed:
                    self.ready.set()
        except (WebSocketClosedError, asyncio.CancelledError):
            pass
        finally:
            self.close("DolphinDB 连接已断开")

    def close(self, reason="会话已关闭"):
        self.closed = True
        self.state = "disconnected"
        self.ready.set()
        if self.current_run is not None:
            self.current_run["status"] = "disconnected"
            self.current_run["finished"] = timestamp()
            self.current_run = None
        if self.client is not None:
            self.client.close(code=1001, reason=reason)
            self.client = None
        if self.upstream is not None:
            self.upstream.close()
        if self.reader is not None and not self.reader.done():
            try:
                current = asyncio.current_task()
            except RuntimeError:
                current = None
            if self.reader is not current:
                self.reader.cancel()
        self.password = ""


class DosSessionManager:
    def __init__(self, connections):
        self.connections = connections
        self.sessions: dict[str, DosSession] = {}
        self.lock = asyncio.Lock()

    def list(self, owner):
        for session in list(self.sessions.values()):
            if not session.locked and not session.client and time.monotonic() - session.created > 60:
                session.close()
                self.sessions.pop(session.id, None)
        return [s.summary() for s in self.sessions.values() if s.owner == owner]

    def find(self, owner, session_id):
        session = self.sessions.get(session_id)
        if session is None or session.owner != owner:
            raise ConnectionError("DOS 会话不存在。", 404)
        return session

    async def create(self, owner, path, connection_id, history=None):
        path = document_path(path)
        limits = validated_history_options({} if history is None else history)
        async with self.lock, self.connections.lock:
            for session in self.sessions.values():
                if session.owner == owner and session.path == path:
                    if session.profile["id"] != connection_id:
                        raise ConnectionError("此文件已有会话，连接已固定。", 409)
                    session.configure_history(*limits)
                    return session
            if len(self.sessions) >= 40:
                raise ConnectionError("DOS 会话过多，请先在正在运行面板中关闭不需要的会话。", 429)
            profile = self.connections.find(connection_id)
            password = self.connections.credentials.get(profile)
            session = DosSession(owner, path, profile, password)
            session.configure_history(*limits)
            self.sessions[session.id] = session
            return session

    async def rename(self, owner, session_id, path):
        path = document_path(path)
        async with self.lock:
            session = self.find(owner, session_id)
            if any(
                s.owner == owner and s.path == path and s.id != session_id for s in self.sessions.values()
            ):
                raise ConnectionError("目标文件已有独立会话，不能合并。", 409)
            session.path = path
            return session.summary()

    def shutdown(self, owner, session_id):
        self.find(owner, session_id).close()
        del self.sessions[session_id]

    def close(self):
        for session in self.sessions.values():
            session.close("Jupyter 已关闭")
        self.sessions.clear()
