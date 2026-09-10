"""Authenticated, same-origin WebSocket relay for the upstream DolphinDB JS SDK."""

import asyncio

from jupyter_server.auth.decorator import authorized, ws_authenticated
from jupyter_server.base.handlers import JupyterHandler
from jupyter_server.base.websocket import WebSocketMixin
from tornado import web
from tornado.websocket import WebSocketClosedError, WebSocketHandler, websocket_connect

from .connections import ConnectionError


class DolphinDBRelay(WebSocketMixin, WebSocketHandler, JupyterHandler):
    auth_resource = "dolphindb-connections"

    def initialize(self, manager):
        self.manager = manager
        self.upstream = None
        self.profile = None
        self.reader = None

    def set_default_headers(self):
        pass

    @ws_authenticated
    @authorized(action="execute")
    async def get(self, ticket):
        try:
            self.profile = self.manager.consume_ticket(ticket)
        except ConnectionError as error:
            raise web.HTTPError(error.status) from None
        await super().get(ticket)

    def select_subprotocol(self, subprotocols):
        return subprotocols[0] if subprotocols else None

    async def open(self, ticket):
        super().open()
        profile = self.profile
        host = f"[{profile['host']}]" if ":" in profile["host"] else profile["host"]
        target = f"{'wss' if profile['ssl'] else 'ws'}://{host}:{profile['port']}/"
        protocols = self.request.headers.get("Sec-WebSocket-Protocol", "")
        try:
            self.upstream = await websocket_connect(
                target,
                connect_timeout=profile["timeout"],
                subprotocols=[p.strip() for p in protocols.split(",") if p.strip()],
                max_message_size=64 * 1024 * 1024,
            )
            if self.ws_connection is None or self.ws_connection.is_closing():
                self.upstream.close()
                return
            self.manager.sockets.add(self)
            self.reader = asyncio.create_task(self.forward_messages())
        except Exception:
            self.close(code=1011, reason="DolphinDB server is unreachable")

    async def forward_messages(self):
        try:
            while True:
                message = await self.upstream.read_message()
                if message is None:
                    break
                await self.write_message(message, binary=isinstance(message, bytes))
        except (WebSocketClosedError, asyncio.CancelledError):
            pass
        finally:
            self.close()

    async def on_message(self, message):
        if self.upstream is None:
            self.close(code=1011, reason="DolphinDB server is unreachable")
            return
        try:
            await self.upstream.write_message(message, binary=isinstance(message, bytes))
        except WebSocketClosedError:
            self.close()

    def on_close(self):
        self.manager.sockets.discard(self)
        if self.upstream is not None:
            self.upstream.close()
        if self.reader is not None:
            self.reader.cancel()
