"""IPython magics backed by a real DolphinDB Python SDK session in the kernel."""

from __future__ import annotations

import ast
import atexit
import json
import keyword
import os
import shlex
import threading
from argparse import ArgumentTypeError
from contextlib import suppress
from pathlib import Path

from IPython.core.error import UsageError
from IPython.core.magic import Magics, line_cell_magic, line_magic, magics_class, no_var_expand
from IPython.core.magic_arguments import argument, magic_arguments
from jupyter_core.paths import jupyter_config_dir

from .connections import ConnectionError, Credentials, ProfileStore, validate_profile

COMM_TARGET = "dolphindb-extension:notebook"
RUNNING_COMM_TARGET = "dolphindb-extension:running-session"
SHELL_ATTRIBUTE = "_dolphindb_extension_magics"


class DdbDisplayTransformer(ast.NodeTransformer):
    """Render only a cell's final expression when it directly calls a DDB magic."""

    def visit_Module(self, module):
        if not module.body or not isinstance(module.body[-1], ast.Expr):
            return module
        node = module.body[-1]
        call = node.value
        if not isinstance(call, ast.Call) or not call.args or not isinstance(call.args[0], ast.Constant) or call.args[0].value != "ddb":
            return module
        function = call.func
        if not isinstance(function, ast.Attribute) or function.attr not in ("run_line_magic", "run_cell_magic"):
            return module
        shell = function.value
        if not isinstance(shell, ast.Call) or not isinstance(shell.func, ast.Name) or shell.func.id != "get_ipython" or shell.args or shell.keywords:
            return module
        renderer = ast.Attribute(value=ast.Attribute(value=shell, attr=SHELL_ATTRIBUTE, ctx=ast.Load()),
                                 attr="show_result", ctx=ast.Load())
        module.body[-1] = ast.copy_location(ast.Expr(value=ast.Call(func=renderer, args=[call], keywords=[])), node)
        return module


def _output_name(value):
    if not value.isidentifier() or keyword.iskeyword(value):
        raise ArgumentTypeError("输出名称必须是有效的 Python 变量名。")
    return value


def saved_connection(name: str = "") -> dict:
    """Resolve saved profiles for plain IPython or manually loaded extensions."""
    directory = Path(
        os.environ.get("DOLPHINDB_CONNECTIONS_DIR", str(Path(jupyter_config_dir()) / "dolphindb-extension"))
    ).expanduser()
    store = ProfileStore(directory)
    profiles, active = store.load()
    if name:
        profile = next((p for p in profiles if p["id"] == name or p["name"] == name), None)
    else:
        profile = next((p for p in profiles if p["id"] == active), profiles[0] if profiles else None)
    if profile is None:
        raise UsageError("未找到连接。请在 DolphinDB 侧栏配置连接，并在 Notebook 工具栏选择。")
    credentials = Credentials(directory, store.credential_service)
    return {**profile, "password": credentials.get(profile)}


def open_session(profile: dict):
    try:
        import dolphindb as ddb
        from dolphindb.logger import Sink
        from dolphindb.settings import PROTOCOL_DDB
    except ImportError:
        raise UsageError(
            '当前 Python 内核缺少 DolphinDB SDK，请在该环境安装 "dolphindb-extension[notebook]"。'
        ) from None
    # Keep native SDK types, including DataFrame, ndarray, temporal and decimal values.
    session = ddb.Session(enableSSL=profile["ssl"], protocol=PROTOCOL_DDB, show_output=True)
    try:
        connected = session.connect(
            profile["host"], profile["port"], profile["username"], profile.get("password", ""),
            reconnect=False, highAvailability=False,
        )
        if not connected:
            raise RuntimeError("Connection rejected")
        class NotebookOutput(Sink):
            def handle(self, message):
                # The SDK's native stdout bypasses IPykernel on Windows.
                print(message.log, flush=True)

        session.msg_logger.disable_stdout_sink()
        session.msg_logger.add_sink(NotebookOutput("dolphindb-extension:notebook-output"))
    except Exception:
        with suppress(Exception):
            session.close()
        raise UsageError(
            "DolphinDB 连接失败。请检查地址、账号、密码和 SSL；仅存在服务内存中的密码"
            "需要通过 Notebook 工具栏选择连接。"
        ) from None
    return session


@magics_class
class DolphinDBMagics(Magics):
    def __init__(self, shell):
        super().__init__(shell)
        from .browser import ResultBrowser
        self.browser = ResultBrowser()
        self.show_function = self.show
        self.display_transformer = DdbDisplayTransformer()
        self.browse_cache = {}
        self.session_id = ""
        self.profile: dict | None = None
        self.session = None
        self.preview_session = None
        self.busy = False
        self.configuring = False
        self.configuration_error: str | None = None
        self.requested_id: str | None = None
        self.comms: set = set()
        self.running_comm = None
        self.lock = threading.RLock()
        self.previous: dict = {}

    def state(self, error: str | None = None) -> dict:
        return {
            "kind": "state",
            "browserOwner": self.browser.owner,
            "sessionId": self.session_id,
            "profile": {k: v for k, v in self.profile.items() if k != "password"} if self.profile else None,
            "locked": self.session is not None,
            "busy": self.busy,
            "configuring": self.configuring,
            "requestedId": self.requested_id,
            "error": error or self.configuration_error,
        }

    def publish(self, error: str | None = None) -> None:
        for comm in tuple(self.comms):
            try:
                comm.send(self.state(error))
            except Exception:
                self.comms.discard(comm)
        # A disconnected frontend must never turn a successful SDK call into an error.
        with suppress(Exception):
            self.publish_running(error)

    def publish_running(self, error: str | None = None) -> None:
        """Expose a session through comm_info, even when no notebook view is open."""
        kernel = getattr(self.shell, "kernel", None)
        if kernel is None:
            return
        if self.session is None:
            if self.running_comm is not None:
                self.running_comm.close()
                self.running_comm = None
            return
        if self.running_comm is None:
            from comm import create_comm

            # A passive comm is discovered via Jupyter's comm_info_request. It
            # does not send comm_open to unrelated clients (e.g. ipywidgets).
            comm = create_comm(target_name=RUNNING_COMM_TARGET, primary=False)
            kernel.comm_manager.register_comm(comm)
            self.running_comm = comm

            def receive(message):
                data = message.get("content", {}).get("data", {})
                if not isinstance(data, dict):
                    return
                if data.get("kind") == "close":
                    try:
                        self.close()
                    except Exception:
                        self.publish("DDB 会话关闭失败，请重试。")
                elif data.get("kind") == "status":
                    self.publish_running()

            comm.on_msg(receive)
        self.running_comm.send({**self.state(error), "kind": "running-session"})

    def configure(self, data: dict) -> None:
        with self.lock:
            if self.session is not None:
                raise UsageError("会话连接已固定。请先运行 %ddb_close，再选择连接。")
            try:
                profile = validate_profile(data, data.get("id", ""))
            except (AttributeError, ConnectionError):
                raise UsageError("DolphinDB 连接配置无效，请重新选择连接。") from None
            self.close_preview()
            self.profile = {**profile, "password": data.get("password", "")}
            self.configuring = False
            self.configuration_error = None
            self.requested_id = profile["id"]
            self.publish()

    def open_comm(self, comm, message) -> None:
        self.comms.add(comm)

        def disconnect(_message):
            with self.lock:
                self.comms.discard(comm)
                if not self.comms:
                    self.close_preview()

        comm.on_close(disconnect)

        def receive(message):
            data = message.get("content", {}).get("data", {})
            try:
                if not isinstance(data, dict):
                    raise UsageError("DolphinDB 配置消息无效。")
                if "settings" in data:
                    self.browser.configure(data["settings"])
                if data.get("kind") == "metadata":
                    request_id = data.get("id")
                    try:
                        result = self.metadata(data.get("operation"), data.get("arguments", {}))
                        comm.send({"kind": "metadata", "id": request_id, "result": result})
                    except Exception:
                        comm.send({"kind": "metadata", "id": request_id, "error": "DDB 元数据暂不可用。"})
                elif data.get("kind") == "configure":
                    self.configure(data.get("profile"))
                elif data.get("kind") in ("prepare", "configuration-error"):
                    with self.lock:
                        if self.session is None:
                            self.configuring = data["kind"] == "prepare"
                            if self.configuring:
                                requested_id = data.get("connectionId")
                                if requested_id is not None and not isinstance(requested_id, str):
                                    raise UsageError("请选择有效的 DolphinDB 连接。")
                                self.requested_id = requested_id
                            self.configuration_error = (
                                None if self.configuring else "无法读取所选连接，请在 Notebook 工具栏重新选择。"
                            )
                        self.publish()
                elif data.get("kind") == "close":
                    self.close()
                else:
                    self.publish()
            except (UsageError, ConnectionError, ValueError) as error:
                self.publish(str(error))

        comm.on_msg(receive)
        # Opening another page observes the existing kernel session; it never resets it.
        data = message.get("content", {}).get("data", {})
        if isinstance(data, dict) and "settings" in data:
            try:
                self.browser.configure(data["settings"])
            except ValueError as error:
                self.publish(str(error))
                return
        self.publish()

    def execute(self, code: str):
        if not code.strip():
            raise UsageError("请在 %ddb 后填写代码，或使用 %%ddb 执行多行代码。")
        with self.lock:
            if self.configuring:
                raise UsageError("DDB 连接正在准备，请等待 Notebook 工具栏就绪后执行。")
            if self.configuration_error:
                raise UsageError(self.configuration_error)
            self.busy = True
            self.publish()
            try:
                if self.session is None:
                    self.close_preview()
                    if self.profile is None:
                        try:
                            self.profile = saved_connection()
                        except ConnectionError as error:
                            raise UsageError(str(error)) from None
                    self.session = open_session(self.profile)
                    from uuid import uuid4
                    self.session_id = uuid4().hex
                    self.publish()
                # Return the object itself: IPython's assignment syntax captures this value.
                self.browse_cache.clear()
                return self.session.run(code)
            finally:
                self.busy = False
                self.publish()

    @line_cell_magic
    @no_var_expand
    @magic_arguments()
    @argument("-o", "--out", type=_output_name, help="将多行脚本的返回结果保存为 Python 变量。")
    def ddb(self, line: str, cell: str | None = None):
        """Run DDB: result = %ddb expression; or %%ddb [-o result] followed by a script."""
        if cell is None:
            return self.execute(line)
        try:
            # Consistent strict quoting on Windows and Unix; IPython owns the options/help.
            output = self.ddb.parser.parse_args(shlex.split(line)).out
        except ValueError as error:
            raise UsageError(str(error)) from None
        result = self.execute(cell)
        if output is not None:
            self.shell.user_ns[output] = result
            return None
        return result

    @line_magic
    @no_var_expand
    def ddb_connect(self, line: str):
        """Select a saved profile by name/ID, or show the current session without credentials."""
        if not line.strip():
            return self.state()
        try:
            args = shlex.split(line)
            if len(args) != 1:
                raise UsageError('用法：%ddb_connect "连接名称或 ID"')
            self.configure(saved_connection(args[0]))
        except (ValueError, ConnectionError) as error:
            raise UsageError(str(error)) from None

    def show(self, value) -> None:
        """Render only the supplied Python object, without running any DDB code."""
        from IPython.display import display

        from .browser import SHOW_MIME

        with self.lock:
            ticket = self.browser.ticket(value)
        fallback, _ = self.shell.display_formatter.format(value, include=["text/plain"])
        display({**fallback, SHOW_MIME: ticket}, raw=True)

    def show_result(self, value) -> None:
        """Automatic magic output skips None, like IPython's ordinary display hook."""
        if value is not None:
            self.show(value)

    @line_magic
    @no_var_expand
    def ddb_show(self, line: str):
        """Explicitly display a Python expression with DDB components: %ddb_show result."""
        if not line.strip():
            raise UsageError("用法：%ddb_show Python对象或表达式，例如 %ddb_show aaa")
        self.show(eval(line, self.shell.user_global_ns, self.shell.user_ns))

    @line_magic
    def ddb_close(self, line: str):
        """Close this kernel's DDB session so another connection can be selected."""
        if line.strip():
            raise UsageError("%ddb_close 不接受参数。")
        self.close()

    def close(self) -> None:
        with self.lock:
            self.browse_cache.clear()
            self.session_id = ""
            self.close_preview()
            if self.session is not None:
                self.session.close()
                self.session = None
            self.publish()

    def close_preview(self) -> None:
        self.browse_cache.clear()
        if self.preview_session is not None:
            with suppress(Exception):
                self.preview_session.close()
            self.preview_session = None

    def metadata(self, operation: str, arguments: dict):
        from .metadata import inspect_session

        with self.lock:
            if operation == "browse" and isinstance(arguments, dict):
                from .browser import session_page
                target = json.loads(arguments.get("target", "null"))
                query = json.loads(arguments.get("request", "null"))
                if isinstance(target, dict) and target.get("kind") == "result":
                    return self.browser.read(target, query)
            else:
                target = query = None
            if self.busy or self.configuring or self.configuration_error or not self.profile:
                raise UsageError("DDB 连接尚未就绪。")
            if not isinstance(arguments, dict):
                raise UsageError("DDB 元数据请求无效。")
            # A preview must not lock the execution connection or introduce user variables.
            session = self.session
            if session is None:
                if self.preview_session is None:
                    self.preview_session = open_session(self.profile)
                session = self.preview_session
            if operation == "browse":
                return session_page(session, target, query, self.browse_cache)
            return inspect_session(session, operation, arguments, self.browser.settings)


def load_ipython_extension(shell) -> None:
    if getattr(shell, SHELL_ATTRIBUTE, None) is not None:
        return
    magics = DolphinDBMagics(shell)
    for kind, functions in magics.magics.items():
        for name in functions:
            magics.previous[kind, name] = shell.magics_manager.magics[kind].get(name)
    shell.register_magics(magics)
    shell.ast_transformers.append(magics.display_transformer)
    # A user-defined name always wins; the magic and explicit import remain available.
    shell.user_ns.setdefault("ddb_show", magics.show_function)
    setattr(shell, SHELL_ATTRIBUTE, magics)
    kernel = getattr(shell, "kernel", None)
    if kernel is not None:
        kernel.comm_manager.register_target(COMM_TARGET, magics.open_comm)
    atexit.register(magics.close)


def load_notebook_extension(shell) -> None:
    """Bootstrap without falling back to a different on-disk profile before the comm arrives."""
    shell.extension_manager.load_extension("dolphindb_extension")
    magics = getattr(shell, SHELL_ATTRIBUTE)
    if magics.profile is None:
        magics.configuring = True


def unload_ipython_extension(shell) -> None:
    magics = getattr(shell, SHELL_ATTRIBUTE, None)
    if magics is None:
        return
    magics.close()
    magics.browser.dispose()
    if magics.display_transformer in shell.ast_transformers:
        shell.ast_transformers.remove(magics.display_transformer)
    if shell.user_ns.get("ddb_show") is magics.show_function:
        shell.user_ns.pop("ddb_show")
    for comm in tuple(magics.comms):
        with suppress(Exception):
            comm.close()
    kernel = getattr(shell, "kernel", None)
    if kernel is not None:
        kernel.comm_manager.unregister_target(COMM_TARGET, magics.open_comm)
    for (kind, name), previous in magics.previous.items():
        table = shell.magics_manager.magics[kind]
        if getattr(table.get(name), "__self__", None) is magics:
            if previous is None:
                table.pop(name, None)
            else:
                table[name] = previous
    shell.magics_manager.registry.pop(type(magics).__name__, None)
    delattr(shell, SHELL_ATTRIBUTE)
    atexit.unregister(magics.close)
