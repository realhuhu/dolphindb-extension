"""Authenticated document-session API and SDK transport."""

from jupyter_server.auth.decorator import authorized, ws_authenticated
from jupyter_server.base.handlers import JupyterHandler
from jupyter_server.base.websocket import WebSocketMixin
from jupyter_server.utils import url_path_join
from tornado import web
from tornado.websocket import WebSocketHandler

from .connections import ConnectionError
from .dos_sessions import DOS_RESOURCE
from .handlers import BaseHandler, connection_errors


class DosBaseHandler(BaseHandler):
    auth_resource = DOS_RESOURCE

    @property
    def owner(self):
        return self.current_user.username


class DosSessionsHandler(DosBaseHandler):
    @web.authenticated
    @authorized
    @connection_errors
    async def get(self):
        self.finish({"sessions": self.manager.list(self.owner)})

    @web.authenticated
    @authorized(action="execute")
    @connection_errors
    async def post(self):
        data = self.body()
        session = await self.manager.create(self.owner, data.get("path"), data.get("connectionId"))
        self.finish(session.summary())


class DosSessionHandler(DosBaseHandler):
    @web.authenticated
    @authorized
    @connection_errors
    async def get(self, session_id):
        session = self.manager.find(self.owner, session_id)
        self.finish({**session.summary(), "history": session.history})

    @web.authenticated
    @authorized
    @connection_errors
    async def patch(self, session_id):
        self.finish(await self.manager.rename(self.owner, session_id, self.body().get("path")))

    @web.authenticated
    @authorized(action="execute")
    @connection_errors
    async def delete(self, session_id):
        self.manager.shutdown(self.owner, session_id)
        self.set_status(204)
        self.finish()


class DosAttachHandler(DosBaseHandler):
    @web.authenticated
    @authorized(action="execute")
    @connection_errors
    async def post(self, session_id):
        session = self.manager.find(self.owner, session_id)
        if session.closed or session.client:
            raise ConnectionError("会话已断开，或正在另一页面使用。", 409)
        self.finish(
            {
                "path": f"dolphindb-extension/dos-sessions/{session.id}/ws",
                "username": session.profile["username"] if session.handshake is None else "",
                "password": session.password if session.handshake is None else "",
                "timeout": session.profile["timeout"],
            }
        )


class DosControlHandler(DosBaseHandler):
    @web.authenticated
    @authorized(action="execute")
    @connection_errors
    async def post(self, session_id):
        session = self.manager.find(self.owner, session_id)
        data = {**session.profile, "password": session.password, "rememberPassword": False}
        data.pop("id")
        self.finish(await self.manager.connections.prepare(data))


class DosSocket(WebSocketMixin, WebSocketHandler, JupyterHandler):
    auth_resource = DOS_RESOURCE

    def initialize(self, manager):
        self.manager = manager
        self.session = None

    def set_default_headers(self):
        pass

    @ws_authenticated
    @authorized(action="execute")
    async def get(self, session_id):
        try:
            self.session = self.manager.find(self.current_user.username, session_id)
            if self.session.closed or self.session.client:
                raise ConnectionError("会话不可用。", 409)
        except ConnectionError as error:
            raise web.HTTPError(error.status) from None
        await super().get(session_id)

    async def open(self, session_id):
        super().open()
        try:
            await self.session.attach(self)
        except ConnectionError as error:
            self.close(code=1011, reason=str(error))

    async def on_message(self, data):
        try:
            await self.session.send(data)
        except ConnectionError as error:
            self.close(code=1011, reason=str(error))

    def on_close(self):
        if self.session:
            self.session.detach(self)


def setup_dos_handlers(web_app, manager):
    root = url_path_join(web_app.settings["base_url"], "dolphindb-extension", "dos-sessions")
    item = url_path_join(root, r"([a-f0-9-]{36})")
    options = {"manager": manager}
    web_app.add_handlers(
        ".*$",
        [
            (root, DosSessionsHandler, options),
            (item, DosSessionHandler, options),
            (url_path_join(item, "attach"), DosAttachHandler, options),
            (url_path_join(item, "control"), DosControlHandler, options),
            (url_path_join(item, "ws"), DosSocket, options),
        ],
    )
