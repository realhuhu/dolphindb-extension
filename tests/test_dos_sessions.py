import asyncio
import json
from http.cookies import SimpleCookie

import pytest

from dolphindb_extension.connections import ConnectionError, ConnectionManager
from dolphindb_extension.dos_sessions import DosSession, DosSessionManager, document_path

CONNECTED = b"12345 1 1\nOK\n\x01\x00\x01"
RESULT = b"12345 1 1\nOK\n\x04\x00\x2a\x00\x00\x00"


class Client:
    def __init__(self):
        self.messages = []
        self.closed = False

    async def write_message(self, data, binary):
        self.messages.append(data)

    def close(self, **kwargs):
        self.closed = True


class Upstream:
    def __init__(self):
        self.responses = asyncio.Queue()
        self.requests = []
        self.closed = False

    async def write_message(self, data, binary):
        self.requests.append(data)

    async def read_message(self):
        return await self.responses.get()

    def close(self):
        self.closed = True


@pytest.fixture
def session(monkeypatch):
    socket = Upstream()

    async def connect(*args, **kwargs):
        return socket

    monkeypatch.setattr("dolphindb_extension.dos_sessions.websocket_connect", connect)
    model = DosSession(
        "owner",
        "one.dos",
        {
            "id": "profile",
            "name": "Local",
            "host": "localhost",
            "port": 8848,
            "ssl": False,
            "timeout": 10,
            "username": "admin",
        },
        "private-password",
    )
    yield model, socket
    model.close()


async def reply(session, socket, data):
    socket.responses.put_nowait(data)
    await asyncio.wait_for(session.ready.wait(), 1)


async def test_reattach_reuses_handshake_and_never_reconnects(session):
    model, socket = session
    first = Client()
    await model.attach(first)
    await model.send(b"API2 0 8 / 0\nconnect\n")
    await reply(model, socket, CONNECTED)
    await model.send(b"API2 12345 31 / 0\nscript\nline://1\nx = 42\nx")
    await reply(model, socket, RESULT)
    assert model.locked and model.sequence == 1
    assert model.state == "idle"
    model.detach(first)
    assert not socket.closed
    second = Client()
    await model.attach(second)
    await model.send(b"API2 0 8 / 0\nconnect\n")
    assert second.messages == [CONNECTED]
    assert len(socket.requests) == 2
    assert model.history[0]["status"] == "ok"
    assert "private-password" not in json.dumps(model.summary())


async def test_inflight_execution_survives_detach_and_is_not_delivered_to_new_handshake(session):
    model, socket = session
    first = Client()
    await model.attach(first)
    await model.send(b"API2 0 8 / 0\nconnect\n")
    await reply(model, socket, CONNECTED)
    await model.send(b"API2 12345 31 / 0\nscript\nline://7\nsleep(100)\nx")
    model.detach(first)
    second = Client()
    await model.attach(second)
    handshake = asyncio.create_task(model.send(b"API2 0 8 / 0\nconnect\n"))
    socket.responses.put_nowait(b"MSG\nstill running\x00")
    socket.responses.put_nowait(RESULT)
    await asyncio.wait_for(handshake, 1)
    assert second.messages == [CONNECTED]
    assert len(model.history[0]["frames"]) == 2
    assert model.history[0]["line"] == "7"
    assert model.state == "idle"


async def test_exclusive_attachment_and_connection_loss(session):
    model, socket = session
    await model.attach(Client())
    with pytest.raises(ConnectionError, match="另一页面"):
        await model.attach(Client())
    await model.send(b"API2 0 8 / 0\nconnect\n")
    await reply(model, socket, CONNECTED)
    await model.send(b"API2 12345 20 / 0\nscript\nline://1\nsleep(100)")
    socket.responses.put_nowait(None)
    await asyncio.wait_for(model.ready.wait(), 1)
    assert model.state == "disconnected"
    assert model.history[0]["status"] == "disconnected"
    assert model.locked
    with pytest.raises(ConnectionError, match="已断开"):
        await model.attach(Client())


async def test_script_errors_lock_the_connection_and_history_is_bounded(session, monkeypatch):
    model, socket = session
    await model.attach(Client())
    await model.send(b"API2 0 8 / 0\nconnect\n")
    await reply(model, socket, CONNECTED)
    await model.send(b"API2 12345 20 / 0\nscript\nline://1\ninvalid()")
    await reply(model, socket, b"12345 0 1\nUnknown function\n")
    assert model.locked and model.history[-1]["status"] == "error"
    for _ in range(21):
        await model.send(b"API2 12345 20 / 0\nscript\nline://1\n42")
        await reply(model, socket, RESULT)
    assert len(model.history) == 20 and model.sequence == 22
    monkeypatch.setattr(model, "history_bytes", 150)
    await model.send(b"API2 12345 20 / 0\nscript\nline://1\nprint(42)")
    socket.responses.put_nowait(b"MSG\n" + b"x" * 200 + b"\0")
    await reply(model, socket, RESULT)
    assert model.history[-1]["truncated"]
    assert model.history[-1]["status"] == "ok"


async def test_failed_handshake_does_not_lock_and_malformed_rpc_is_rejected(session):
    model, socket = session
    await model.attach(Client())
    with pytest.raises(ConnectionError):
        await model.send(b"API2 missing-newline")
    await model.send(b"API2 0 8 / 0\nconnect\n")
    await reply(model, socket, b"12345 0 1\nLogin failed\n")
    assert not model.locked and model.handshake is None
    assert not model.history


async def test_document_uniqueness_owner_isolation_and_profile_snapshot(tmp_path):
    connections = ConnectionManager(tmp_path)
    manager = DosSessionManager(connections)
    try:
        profile = (await connections.save({"name": "Local", "host": "localhost", "password": "private"}))[
            "connections"
        ][0]
        a = await manager.create("alice", "a.dos", profile["id"])
        b = await manager.create("alice", "b.dos", profile["id"])
        other = await manager.create("bob", "a.dos", profile["id"])
        assert len({a.id, b.id, other.id}) == 3
        assert await manager.create("alice", "a.dos", profile["id"]) is a
        with pytest.raises(ConnectionError, match="固定"):
            await manager.create("alice", "a.dos", "different")
        with pytest.raises(ConnectionError) as error:
            manager.find("bob", a.id)
        assert error.value.status == 404
        with pytest.raises(ConnectionError, match="不能合并"):
            await manager.rename("alice", a.id, "b.dos")
        await manager.rename("alice", a.id, "renamed.dos")
        assert a.path == "renamed.dos"
        await connections.save({**profile, "host": "changed", "password": "new"}, profile["id"])
        assert a.profile["host"] == "localhost" and a.password == "private"
        await connections.delete(profile["id"])
        assert len(manager.list("alice")) == 2
        manager.shutdown("alice", a.id)
        assert a.closed and a.password == ""
        assert len(manager.list("alice")) == 1
    finally:
        manager.close()
        connections.close()


@pytest.mark.parametrize(
    "path", [None, "one.txt", "../one.dos", "/one.dos", "a//one.dos", "a\\one.dos", "a\n.dos"]
)
def test_invalid_document_paths(path):
    with pytest.raises(ConnectionError):
        document_path(path)


async def test_dos_api_authentication_and_lifecycle(jp_fetch):
    profile = await jp_fetch(
        "dolphindb-extension",
        "connections",
        method="POST",
        body=json.dumps({"name": "API", "host": "localhost"}),
    )
    connection_id = json.loads(profile.body)["connections"][0]["id"]
    response = await jp_fetch(
        "dolphindb-extension",
        "dos-sessions",
        method="POST",
        body=json.dumps({"path": "api.dos", "connectionId": connection_id}),
    )
    session_id = json.loads(response.body)["id"]
    cookies = SimpleCookie()
    for value in response.headers.get_list("Set-Cookie"):
        cookies.load(value)
    headers = {"Cookie": "; ".join(f"{key}={m.value}" for key, m in cookies.items())}
    # Jupyter's anonymous token identity is persisted by its signed login cookie.
    listed = await jp_fetch("dolphindb-extension", "dos-sessions", headers=headers)
    assert json.loads(listed.body)["sessions"][0]["id"] == session_id
    renamed = await jp_fetch(
        "dolphindb-extension",
        "dos-sessions",
        session_id,
        method="PATCH",
        body=json.dumps({"path": "renamed.dos"}),
        headers=headers,
    )
    assert json.loads(renamed.body)["path"] == "renamed.dos"
    await jp_fetch("dolphindb-extension", "dos-sessions", session_id, method="DELETE", headers=headers)
    listed = await jp_fetch("dolphindb-extension", "dos-sessions", headers=headers)
    assert not json.loads(listed.body)["sessions"]
