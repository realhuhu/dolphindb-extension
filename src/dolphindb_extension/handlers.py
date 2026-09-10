"""Authenticated Jupyter Server API for the connection sidebar."""

from __future__ import annotations

from functools import wraps
from typing import Any

from jupyter_server.auth.decorator import authorized
from jupyter_server.base.handlers import APIHandler
from jupyter_server.utils import url_path_join
from tornado import web

from .connections import AUTH_RESOURCE, ConnectionError, ConnectionManager


def connection_errors(method):
    @wraps(method)
    async def wrapped(self, *args, **kwargs):
        try:
            await method(self, *args, **kwargs)
        except ConnectionError as error:
            self.set_status(error.status)
            self.finish({"message": str(error)})

    return wrapped


class BaseHandler(APIHandler):
    auth_resource = AUTH_RESOURCE

    def initialize(self, manager: ConnectionManager) -> None:
        self.manager = manager

    def set_default_headers(self) -> None:
        super().set_default_headers()
        self.set_header("Cache-Control", "no-store")

    def body(self) -> dict[str, Any]:
        if len(self.request.body) > 16_384:
            raise ConnectionError("连接配置过大。", 413)
        body = self.get_json_body()
        if not isinstance(body, dict):
            raise ConnectionError("请求内容必须为 JSON 对象。")
        return body


class ConnectionsHandler(BaseHandler):
    @web.authenticated
    @authorized
    @connection_errors
    async def get(self):
        async with self.manager.lock:
            self.finish(self.manager.snapshot())

    @web.authenticated
    @authorized
    @connection_errors
    async def post(self):
        result = await self.manager.save(self.body())
        self.set_status(201)
        self.finish(result)


class ConnectionHandler(BaseHandler):
    @web.authenticated
    @authorized
    @connection_errors
    async def put(self, connection_id):
        self.finish(await self.manager.save(self.body(), connection_id))

    @web.authenticated
    @authorized
    @connection_errors
    async def delete(self, connection_id):
        self.finish(await self.manager.delete(connection_id))


class SessionHandler(BaseHandler):
    @web.authenticated
    @authorized(action="execute")
    @connection_errors
    async def post(self):
        self.finish(await self.manager.prepare(self.body()))


class ActiveHandler(BaseHandler):
    @web.authenticated
    @authorized(action="execute")
    @connection_errors
    async def put(self):
        connection_id = self.body().get("connectionId")
        if not isinstance(connection_id, str):
            raise ConnectionError("请选择要连接的服务器。")
        self.finish(await self.manager.select(connection_id))


class KernelConnectionHandler(BaseHandler):
    """Supply one connection to a Python kernel over an authenticated Jupyter comm."""

    @web.authenticated
    @authorized(action="execute")
    @connection_errors
    async def post(self):
        connection_id = self.body().get("connectionId")
        if connection_id is not None and not isinstance(connection_id, str):
            raise ConnectionError("请选择有效的 DolphinDB 连接。")
        async with self.manager.lock:
            if connection_id is None:
                connection_id = self.manager.active_id or next(
                    (p["id"] for p in self.manager.profiles), None
                )
            if connection_id is None:
                raise ConnectionError("请先在 DolphinDB 侧栏配置连接。")
            profile = self.manager.find(connection_id)
            self.finish({**profile, "password": self.manager.credentials.get(profile)})


def setup_handlers(web_app, manager: ConnectionManager) -> None:
    from .relay import DolphinDBRelay

    root = url_path_join(web_app.settings["base_url"], "dolphindb-extension")
    options = {"manager": manager}
    web_app.add_handlers(
        ".*$",
        [
            (url_path_join(root, "connections"), ConnectionsHandler, options),
            (url_path_join(root, "connections", r"([a-f0-9-]{36})"), ConnectionHandler, options),
            (url_path_join(root, "sessions"), SessionHandler, options),
            (url_path_join(root, "active"), ActiveHandler, options),
            (url_path_join(root, "kernel-connection"), KernelConnectionHandler, options),
            (url_path_join(root, "ws", r"([A-Za-z0-9_-]{43})"), DolphinDBRelay, options),
        ],
    )
