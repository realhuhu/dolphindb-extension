import asyncio
import json

import pytest
from tornado.httpclient import HTTPClientError
from tornado.httpserver import HTTPServer
from tornado.netutil import bind_sockets
from tornado.web import Application
from tornado.websocket import WebSocketHandler


async def test_authenticated_crud_under_jupyter_base_url(jp_fetch):
    response = await jp_fetch("dolphindb-extension", "connections")
    assert response.code == 200
    assert response.headers["Cache-Control"] == "no-store"
    data = {"name": "API test", "host": "localhost", "port": 8848, "password": "test-only-secret"}
    response = await jp_fetch("dolphindb-extension", "connections", method="POST", body=json.dumps(data))
    assert response.code == 201
    assert data["password"].encode() not in response.body
    connection_id = json.loads(response.body)["connections"][0]["id"]
    selected = await jp_fetch(
        "dolphindb-extension", "active", method="PUT", body=json.dumps({"connectionId": connection_id})
    )
    assert json.loads(selected.body)["activeId"] == connection_id
    response = await jp_fetch("dolphindb-extension", "connections", connection_id, method="DELETE")
    assert json.loads(response.body)["connections"] == []


async def test_unauthenticated_http_is_rejected(jp_fetch):
    with pytest.raises(HTTPClientError) as error:
        await jp_fetch("dolphindb-extension", "connections", headers={"Authorization": "token invalid"})
    assert error.value.code == 403


async def test_malformed_body_is_rejected(jp_fetch):
    with pytest.raises(HTTPClientError) as error:
        await jp_fetch("dolphindb-extension", "connections", method="POST", body="[]")
    assert error.value.code == 400


class EchoSocket(WebSocketHandler):
    def on_message(self, message):
        self.write_message(message, binary=isinstance(message, bytes))


async def test_binary_relay_authentication_and_ticket_replay(jp_fetch, jp_ws_fetch):
    sockets = bind_sockets(0, "127.0.0.1")
    port = sockets[0].getsockname()[1]
    server = HTTPServer(Application([(r"/", EchoSocket)]))
    server.add_sockets(sockets)
    relay = None
    try:
        response = await jp_fetch(
            "dolphindb-extension",
            "sessions",
            method="POST",
            body=json.dumps({"name": "Relay test", "host": "127.0.0.1", "port": port}),
        )
        path = json.loads(response.body)["path"]
        with pytest.raises(HTTPClientError) as error:
            await jp_ws_fetch(path, headers={"Authorization": "token invalid"})
        assert error.value.code == 403
        relay = await jp_ws_fetch(path)
        await relay.write_message(b"\x00\xffDolphinDB", binary=True)
        assert await asyncio.wait_for(relay.read_message(), 3) == b"\x00\xffDolphinDB"
        with pytest.raises(HTTPClientError) as error:
            await jp_ws_fetch(path)
        assert error.value.code == 404
    finally:
        if relay:
            relay.close()
        server.stop()
        await server.close_all_connections()
