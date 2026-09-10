import json
from types import SimpleNamespace

import numpy as np
import pandas as pd
import pytest
from IPython.core.error import UsageError
from IPython.core.interactiveshell import InteractiveShell
from traitlets.config import Config

from dolphindb_extension import load_ipython_extension, unload_ipython_extension
from dolphindb_extension.magics import (
    COMM_TARGET,
    SHELL_ATTRIBUTE,
    load_notebook_extension,
    open_session,
    saved_connection,
)

PROFILE = {"id": "local", "name": "Local", "host": "localhost", "port": 8848, "username": "admin",
           "password": "test-only-secret", "ssl": False, "timeout": 10, "rememberPassword": False}


class Session:
    def __init__(self):
        self.result = None
        self.calls = []
        self.closed = False
        self.error = None

    def run(self, code):
        self.calls.append(code)
        if self.error:
            raise self.error
        return self.result

    def close(self):
        self.closed = True


class Comm:
    def __init__(self):
        self.messages = []

    def send(self, data):
        self.messages.append(data)

    def on_close(self, callback):
        self.close_callback = callback

    def on_msg(self, callback):
        self.message_callback = callback

    def receive(self, data):
        self.message_callback({"content": {"data": data}})

    def close(self):
        self.close_callback({})


@pytest.fixture
def magic(monkeypatch):
    shell = InteractiveShell(config=Config({"HistoryManager": {"enabled": False}}))
    load_ipython_extension(shell)
    instance = getattr(shell, SHELL_ATTRIBUTE)
    instance.configure(PROFILE)
    sessions = []

    def create(profile):
        session = Session()
        sessions.append(session)
        return session

    monkeypatch.setattr("dolphindb_extension.magics.open_session", create)
    yield shell, instance, sessions
    unload_ipython_extension(shell)
    shell.history_manager.end_session()


@pytest.mark.parametrize("value", [7, np.array([1, 2, 3]), pd.DataFrame({"id": [1, 2]}), None])
def test_assignment_returns_original_sdk_object(magic, value):
    shell, instance, sessions = magic
    instance.execute("initialize")
    sessions[0].result = value
    result = shell.run_cell("aaa=%ddb select * from prices", store_history=False)
    assert result.success
    assert shell.user_ns["aaa"] is value
    assert sessions[0].calls[-1] == "select * from prices"
    assert len(sessions) == 1


def test_language_metadata_preview_does_not_lock_execution_connection(magic):
    shell, instance, sessions = magic
    result = instance.metadata("snapshot", {})
    assert result["variables"] == []
    assert instance.session is None
    assert instance.state()["locked"] is False
    preview = sessions[0]
    instance.execute("x = 1")
    assert preview.closed
    assert instance.session is sessions[1]
    instance.metadata("snapshot", {})
    assert len(sessions) == 2


def test_switching_profile_releases_language_preview(magic):
    _, instance, sessions = magic
    instance.metadata("snapshot", {})
    instance.configure({**PROFILE, "id": "another"})
    assert sessions[0].closed
    assert instance.preview_session is None
    assert instance.session is None


def test_last_page_closure_releases_only_language_preview(magic):
    _, instance, sessions = magic
    first, second = Comm(), Comm()
    instance.open_comm(first, {})
    instance.open_comm(second, {})
    first.receive({"kind": "metadata", "id": "preview", "operation": "snapshot"})
    assert first.messages[-1]["kind"] == "metadata"
    assert first.messages[-1]["id"] == "preview"
    first.close()
    assert not sessions[0].closed
    second.close()
    assert sessions[0].closed
    assert instance.preview_session is None
    assert instance.session is None


def test_cell_magic_captures_multiline_result_and_preserves_script(magic):
    shell, instance, sessions = magic
    instance.execute("initialize")
    table = pd.DataFrame({"value": [1.5]})
    sessions[0].result = table
    code = 't = table(1.5 as value)\n// preserve comments and whitespace\nt\n'
    result = shell.run_cell("%%ddb -o result\n" + code, store_history=False)
    assert result.success
    assert result.result is None
    assert shell.user_ns["result"] is table
    assert sessions[0].calls[-1] == code
    assert shell.run_cell("%%ddb\n1 + 1", store_history=False).result is table


def test_ddb_syntax_is_not_interpolated_by_ipython(magic):
    shell, _, sessions = magic
    shell.user_ns["value"] = "incorrect substitution"
    code = 'add{value,}(1); "$value"'
    assert shell.run_cell("result = %ddb " + code, store_history=False).success
    assert sessions[0].calls[-1] == code


@pytest.mark.parametrize("line", ["output", "-o 1bad", "-o for", "-o a.b", "--out", '-o "bad'])
def test_invalid_output_name_never_executes(magic, line):
    _, instance, sessions = magic
    with pytest.raises(UsageError):
        instance.ddb(line, "writeToDatabase()")
    assert sessions == []


def test_session_reuse_lock_errors_and_explicit_close(magic):
    _, instance, sessions = magic
    instance.execute("x = 1")
    with pytest.raises(UsageError, match="固定"):
        instance.configure({**PROFILE, "name": "Another"})
    sessions[0].error = RuntimeError("DDB syntax error")
    with pytest.raises(RuntimeError, match="DDB syntax error"):
        instance.execute("bad code")
    assert instance.state()["locked"]
    assert not instance.busy
    sessions[0].error = None
    instance.execute("x + 1")
    assert len(sessions) == 1
    instance.ddb_close("")
    assert sessions[0].closed
    instance.configure({**PROFILE, "name": "Another"})
    instance.execute("new session")
    assert len(sessions) == 2


def test_comm_closure_keeps_session_and_never_broadcasts_credentials(magic):
    _, instance, sessions = magic
    first, second = Comm(), Comm()
    instance.open_comm(first, {})
    instance.execute("x = 1")
    first.close()
    assert not sessions[0].closed
    instance.open_comm(second, {})
    assert second.messages[-1]["locked"]
    second.receive({"kind": "configure", "profile": {**PROFILE, "name": "Another"}})
    assert second.messages[-1]["error"]
    assert instance.profile["name"] == "Local"
    assert PROFILE["password"] not in json.dumps(first.messages + second.messages)
    assert "password" not in instance.ddb_connect("")["profile"]
    second.receive({"kind": "close"})
    assert sessions[0].closed
    assert not second.messages[-1]["locked"]


def test_pending_or_failed_configuration_cannot_run_previous_connection(magic):
    _, instance, sessions = magic
    comm = Comm()
    instance.open_comm(comm, {})
    comm.receive({"kind": "prepare", "connectionId": "new-selection"})
    assert instance.state()["requestedId"] == "new-selection"
    with pytest.raises(UsageError, match="准备"):
        instance.execute("writeToDatabase()")
    comm.receive({"kind": "configuration-error"})
    with pytest.raises(UsageError, match="所选连接"):
        instance.execute("writeToDatabase()")
    assert not sessions
    comm.receive({"kind": "configure", "profile": PROFILE})
    instance.execute("1 + 1")
    assert len(sessions) == 1


def test_notebook_bootstrap_waits_for_comm_configuration(magic):
    shell, instance, sessions = magic
    instance.profile = None
    load_notebook_extension(shell)
    with pytest.raises(UsageError, match="准备"):
        instance.execute("writeToDatabase()")
    assert not sessions
    instance.configure(PROFILE)
    instance.execute("1 + 1")
    assert len(sessions) == 1


def test_ipython_parses_magic_strings_and_reports_configuration_errors_in_the_cell(magic):
    shell, instance, sessions = magic
    comm = Comm()
    instance.open_comm(comm, {})
    comm.receive({"kind": "configuration-error"})
    result = shell.run_cell('example = "aaa=%ddb 1 + 1"\nhelp_text = """\n%%ddb\n"""', store_history=False)
    assert result.success
    assert shell.user_ns["example"] == "aaa=%ddb 1 + 1"
    assert sessions == []
    result = shell.run_cell("%ddb writeToDatabase()", store_history=False)
    assert isinstance(result.error_in_exec, UsageError)
    assert sessions == []


def test_cell_options_use_ipython_argument_help_and_accept_long_output_form(magic):
    shell, instance, sessions = magic
    assert "--out" in instance.ddb.__doc__
    instance.execute("initialize")
    sessions[0].result = 42
    assert shell.run_cell("%%ddb --out=result\n1 + 1", store_history=False).success
    assert shell.user_ns["result"] == 42


def test_load_is_idempotent_and_unload_closes_session_and_unregisters_comm(magic):
    shell, instance, sessions = magic
    registered = {}
    shell.kernel = SimpleNamespace(comm_manager=SimpleNamespace(
        register_target=lambda name, callback: registered.update({name: callback}),
        unregister_target=lambda name, callback: registered.pop(name),
    ))
    # Reload through the public hook, just like %reload_ext.
    registered[COMM_TARGET] = instance.open_comm
    unload_ipython_extension(shell)
    assert not registered
    load_ipython_extension(shell)
    fresh = getattr(shell, SHELL_ATTRIBUTE)
    fresh.configure(PROFILE)
    fresh.execute("1")
    load_ipython_extension(shell)
    assert getattr(shell, SHELL_ATTRIBUTE) is fresh
    assert len(registered) == 1
    unload_ipython_extension(shell)
    assert sessions[-1].closed
    assert "ddb" not in shell.magics_manager.magics["line"]
    del shell.kernel


def test_saved_profile_uses_custom_directory_and_keyring_namespace(tmp_path, monkeypatch):
    from dolphindb_extension.connections import ProfileStore

    profile = {**PROFILE, "id": "00000000-0000-0000-0000-000000000001", "rememberPassword": True}
    store = ProfileStore(tmp_path)
    store.credential_service = "dolphindb-extension/" + "a" * 24
    store.save([profile], profile["id"])
    monkeypatch.setenv("DOLPHINDB_CONNECTIONS_DIR", str(tmp_path))
    calls = []
    monkeypatch.setattr("dolphindb_extension.magics.Credentials.get", lambda self, p: calls.append(self.service) or "saved")
    assert saved_connection()["password"] == "saved"
    assert calls == [store.credential_service]
    with pytest.raises(UsageError, match="未找到"):
        saved_connection("missing")


def test_native_connection_failure_is_redacted_and_candidate_closed(monkeypatch):
    session = Session()
    session.connect = lambda *args, **kwargs: (_ for _ in ()).throw(RuntimeError(PROFILE["password"]))
    monkeypatch.setattr("dolphindb.Session", lambda **kwargs: session)
    with pytest.raises(UsageError) as error:
        open_session(PROFILE)
    assert PROFILE["password"] not in str(error.value)
    assert session.closed


def test_sdk_print_is_forwarded_once_to_ipython_stdout(monkeypatch, capsys):
    from dolphindb.logger import Level, LogMessage

    session = Session()
    sinks, disabled = [], []
    session.connect = lambda *args, **kwargs: True
    session.msg_logger = SimpleNamespace(
        disable_stdout_sink=lambda: disabled.append(True), add_sink=sinks.append,
    )
    monkeypatch.setattr("dolphindb.Session", lambda **kwargs: session)
    assert open_session(PROFILE) is session
    sinks[0].handle(LogMessage(Level.INFO, "DDB cell output"))
    assert capsys.readouterr().out == "DDB cell output\n"
    assert disabled == [True]
