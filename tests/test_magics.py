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
    RUNNING_COMM_TARGET,
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
        self.uploads = []
        self.closed = False
        self.error = None

    def run(self, code):
        self.calls.append(code)
        if self.error:
            raise self.error
        return self.result

    def close(self):
        self.closed = True

    def upload(self, objects):
        self.uploads.append(objects)
        if self.error:
            raise self.error
        return self.result


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


@pytest.mark.parametrize("value", [7, 1.23456789, np.array([1, 2, 3]), pd.DataFrame({"id": [1, 2]}), {"a": [1, 2]}, None])
def test_assignment_returns_original_sdk_object(magic, value):
    shell, instance, sessions = magic
    native = shell.display_formatter.format(value)
    instance.execute("initialize")
    sessions[0].result = value
    result = shell.run_cell("aaa=%ddb select * from prices", store_history=False)
    assert result.success
    assert shell.user_ns["aaa"] is value
    assert shell.display_formatter.format(shell.user_ns["aaa"]) == native
    assert sessions[0].calls[-1] == "select * from prices"
    assert len(sessions) == 1


def test_session_magic_returns_shared_sdk_session_without_running_code(magic, monkeypatch):
    shell, instance, sessions = magic
    comm = Comm()
    instance.open_comm(comm, {})
    displayed = []
    monkeypatch.setattr(instance, "show_result", displayed.append)
    assert shell.run_cell("session=%ddb_session", store_history=False).success
    session = shell.user_ns["session"]
    assert session is instance.session is sessions[0]
    assert session.calls == []
    assert instance.session_id and instance.state()["locked"]
    assert not instance.busy and comm.messages[-1]["locked"]
    assert PROFILE["password"] not in json.dumps(comm.messages)
    with pytest.raises(UsageError, match="固定"):
        instance.configure({**PROFILE, "name": "Another"})
    session.result = 42
    assert shell.run_cell('direct=session.run("x=42; x")\nvia_magic=%ddb x', store_history=False).success
    assert shell.run_cell("again=%ddb_session", store_history=False).success
    assert shell.user_ns["again"] is session
    assert shell.user_ns["direct"] == shell.user_ns["via_magic"] == 42
    assert session.calls == ["x=42; x", "x"]
    assert shell.run_cell("%ddb_session", store_history=False).success
    assert displayed == [], "SDK sessions must use Python's ordinary output, not the DDB renderer"
    assert len(sessions) == 1


def test_session_magic_replaces_preview_and_reopens_after_explicit_close(magic):
    shell, instance, sessions = magic
    instance.metadata("snapshot", {})
    preview = instance.preview_session
    first = shell.run_line_magic("ddb_session", "")
    first_id = instance.session_id
    assert preview.closed and first is not preview
    assert instance.preview_session is None
    assert shell.run_cell("%ddb_close", store_history=False).success
    assert first.closed and not instance.state()["locked"]
    second = shell.run_line_magic("ddb_session", "")
    assert second is not first and not second.closed
    assert instance.session_id != first_id
    assert second.calls == [] and len(sessions) == 3


def test_session_magic_loads_default_profile_and_recovers_after_connection_failure(magic, monkeypatch):
    shell, instance, sessions = magic
    instance.profile = None
    monkeypatch.setattr("dolphindb_extension.magics.saved_connection", lambda: PROFILE.copy())

    def fail(profile):
        raise UsageError("Connection failed")

    with monkeypatch.context() as failing:
        failing.setattr("dolphindb_extension.magics.open_session", fail)
        with pytest.raises(UsageError, match="Connection failed"):
            shell.run_line_magic("ddb_session", "")
    assert not instance.busy and not instance.state()["locked"] and not instance.session_id
    assert shell.run_line_magic("ddb_session", "") is sessions[0]
    assert instance.profile == PROFILE


@pytest.mark.parametrize("line", ["other", "--new", "{unused}"])
def test_session_magic_rejects_arguments_before_connecting(magic, line):
    shell, instance, sessions = magic
    shell.user_ns["unused"] = ""
    with pytest.raises(UsageError, match="不接受参数"):
        shell.run_line_magic("ddb_session", line)
    assert not sessions and not instance.state()["locked"]


def test_upload_magic_creates_shared_session_and_preserves_python_objects(magic, monkeypatch):
    shell, instance, sessions = magic
    frame = pd.DataFrame({"price": [1.25, 2.5]})
    array = np.array([1, 2, 3], dtype=np.int64)
    shell.user_ns.update(df=frame, vector=array)
    displayed = []
    monkeypatch.setattr(instance, "show_result", displayed.append)
    comm = Comm()
    instance.open_comm(comm, {})
    assert shell.run_cell('%ddb_upload {"prices": df, "values": vector, "literal": "$df {vector}"}',
                          store_history=False).success
    session = sessions[0]
    assert session.uploads[0]["prices"] is frame
    assert session.uploads[0]["values"] is array
    assert session.uploads[0]["literal"] == "$df {vector}"
    assert session.calls == [] and instance.state()["locked"] and not instance.busy
    assert any(message["busy"] for message in comm.messages) and not comm.messages[-1]["busy"]
    assert comm.messages[-1]["locked"]
    assert shell.run_line_magic("ddb_session", "") is session
    session.result = object()
    payload = {"prices": frame}
    shell.user_ns["payload"] = payload
    instance.browse_cache["old page"] = object()
    assert shell.run_cell("uploaded = %ddb_upload payload", store_history=False).success
    assert shell.user_ns["uploaded"] is session.result
    assert session.uploads[-1] is payload and not instance.browse_cache
    assert shell.run_cell("result = %ddb prices", store_history=False).success
    assert session.calls == ["prices"] and len(sessions) == 1
    assert displayed == []


@pytest.mark.parametrize("expression", [
    '{"value": value, "shared": shared}',
    "local_payload",
    '{key: value if key == "value" else shared for key in ("value", "shared")}',
])
def test_upload_magic_uses_calling_function_locals_before_notebook_globals(magic, expression):
    shell, _, sessions = magic
    shell.user_ns.update(value=1, shared=7)
    code = (
        'def upload_local(value):\n'
        '    local_payload = {"value": value, "shared": shared}\n'
        f'    %ddb_upload {expression}\n'
        'upload_local(42)\n'
    )
    assert shell.run_cell(code, store_history=False).success
    assert sessions[0].uploads == [{"value": 42, "shared": 7}]
    assert shell.user_ns["value"] == 1
    assert "local_payload" not in shell.user_ns


@pytest.mark.parametrize("expression, error", [
    ("", UsageError), ("[]", UsageError), ("42", UsageError), ("{1: 2}", UsageError),
    ('{"": 2}', UsageError), ("missing_object", NameError), ("{", SyntaxError),
])
def test_upload_magic_rejects_invalid_input_before_connecting(magic, expression, error):
    shell, instance, sessions = magic
    with pytest.raises(error):
        shell.run_line_magic("ddb_upload", expression)
    assert not sessions and not instance.state()["locked"]


def test_upload_error_preserves_session_and_clears_busy_state_and_stale_pages(magic):
    shell, instance, sessions = magic
    session = shell.run_line_magic("ddb_session", "")
    session_id = instance.session_id
    session.error = RuntimeError("Unsupported upload type")
    instance.browse_cache["old page"] = object()
    with pytest.raises(RuntimeError, match="Unsupported upload type"):
        shell.run_line_magic("ddb_upload", '{"data": object()}')
    assert instance.session is session and instance.session_id == session_id
    assert not instance.busy and not instance.browse_cache and not session.closed
    session.error = None
    shell.run_line_magic("ddb_upload", '{"data": 42}')
    assert session.uploads[-1] == {"data": 42} and len(sessions) == 1


@pytest.mark.parametrize("code", ["%ddb prices", "%%ddb\nprices", "previous = 42\n%ddb prices"])
def test_unassigned_magics_render_once_and_later_python_references_remain_native(magic, monkeypatch, code):
    from dolphindb_extension.browser import SHOW_MIME

    shell, instance, sessions = magic
    instance.execute("initialize")
    value = pd.DataFrame({"price": [1.23456789, 2.34567890]})
    sessions[0].result = value
    output = []
    monkeypatch.setattr("IPython.display.display", lambda bundle, **kwargs: output.append(bundle))
    with pd.option_context("display.precision", 2):
        native = shell.display_formatter.format(value)
        result = shell.run_cell(code, store_history=False)
        assert result.success
        assert shell.display_formatter.format(value) == native
    assert len(output) == 1
    target = output[0][SHOW_MIME]["target"]
    calls = list(sessions[0].calls)
    page = instance.metadata("browse", {"target": json.dumps(target),
                                        "request": json.dumps({"path": [], "offset": 1, "limit": 1, "columnOffset": 0})})
    assert page["grid"]["rows"][0] == ["1", "2.3456789"]
    assert sessions[0].calls == calls


@pytest.mark.parametrize("code", ["aaa = %ddb prices", "aaa = %ddb prices\naaa", "text = '%ddb prices'\ntext",
                                 "%ddb prices\n42", "%%ddb -o captured\nprices"])
def test_assignments_and_magic_looking_strings_never_trigger_custom_rendering(magic, monkeypatch, code):
    shell, instance, sessions = magic
    instance.execute("initialize")
    value = pd.DataFrame({"price": [1.23456789]})
    sessions[0].result = value
    output = []
    monkeypatch.setattr("IPython.display.display", lambda *args, **kwargs: output.append(args))
    assert shell.run_cell(code, store_history=False).success
    assert output == [] and not instance.browser.results


@pytest.mark.parametrize("code", ["ddb_show(aaa)", "%ddb_show aaa", "from dolphindb_extension import ddb_show\nddb_show(aaa)"])
def test_ddb_show_explicitly_renders_its_argument_without_running_or_changing_it(magic, monkeypatch, code):
    from dolphindb_extension.browser import SHOW_MIME

    shell, instance, sessions = magic
    value = pd.DataFrame({"price": [1.23456789, 2.34567890]})
    shell.user_ns["aaa"] = value
    native = shell.display_formatter.format(value)
    output = []
    monkeypatch.setattr("IPython.get_ipython", lambda: shell)
    monkeypatch.setattr("IPython.display.display", lambda bundle, **kwargs: output.append((bundle, kwargs)))
    assert shell.run_cell(code, store_history=False).success
    assert len(output) == 1 and output[0][1] == {"raw": True}
    ticket = output[0][0][SHOW_MIME]
    assert ticket["initial"]["form"] == "TABLE"
    assert output[0][0]["text/plain"] == native[0]["text/plain"]
    assert instance.browser.results[ticket["target"]["id"]] is value
    assert shell.display_formatter.format(value) == native
    assert shell.user_ns["aaa"] is value
    assert not sessions and instance.session is None
    page = instance.metadata("browse", {"target": json.dumps(ticket["target"]),
                                        "request": json.dumps({"path": [], "offset": 1, "limit": 1, "columnOffset": 0})})
    assert page["grid"]["rows"][0] == ["1", "2.3456789"]
    assert not sessions


@pytest.mark.parametrize("value, form", [(None, "SCALAR"), (object(), "SCALAR"), (np.array(42), "SCALAR"),
                                        ([1, 2], "VECTOR"), ({"a": [1, 2]}, "DICT"),
                                        ({"data": 1, "chartType": 2, "title": "ordinary dictionary"}, "DICT")])
def test_ddb_show_accepts_ordinary_python_objects_without_ddb_provenance(magic, monkeypatch, value, form):
    from dolphindb_extension.browser import SHOW_MIME

    _, instance, sessions = magic
    output = []
    monkeypatch.setattr("IPython.display.display", lambda bundle, **kwargs: output.append(bundle))
    instance.show(value)
    assert output[0][SHOW_MIME]["initial"]["form"] == form
    assert not sessions


def test_ddb_show_preserves_user_names_and_unregisters_its_ast_hook(magic):
    shell, instance, _ = magic
    assert shell.user_ns["ddb_show"] is instance.show_function
    assert shell.ast_transformers.count(instance.display_transformer) == 1
    def user_function(value):
        return value
    shell.user_ns["ddb_show"] = user_function
    unload_ipython_extension(shell)
    assert shell.user_ns["ddb_show"] is user_function
    assert instance.display_transformer not in shell.ast_transformers
    load_ipython_extension(shell)
    assert shell.user_ns["ddb_show"] is user_function
    assert "ddb_show" in shell.magics_manager.magics["line"]


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


def test_running_session_is_discoverable_without_a_view_and_closes_only_ddb(magic, monkeypatch):
    import comm

    shell, instance, sessions = magic
    manager = comm.base_comm.CommManager()
    messages = []

    class RunningComm(comm.base_comm.BaseComm):
        def publish_msg(self, msg_type, data=None, **kwargs):
            messages.append((msg_type, data))

    monkeypatch.setattr(comm, "create_comm", RunningComm)
    monkeypatch.setattr(comm, "get_comm_manager", lambda: manager)
    shell.kernel = SimpleNamespace(comm_manager=manager)
    try:
        frontend = Comm()
        instance.open_comm(frontend, {})
        instance.metadata("snapshot", {})
        assert not manager.comms, "preview connections are not running execution sessions"
        shell.user_ns["python_value"] = 42
        instance.execute("ddb_value = 7")
        marker = instance.running_comm
        assert marker.target_name == RUNNING_COMM_TARGET
        assert list(manager.comms.values()) == [marker]
        assert all(kind != "comm_open" for kind, _ in messages)
        assert PROFILE["password"] not in json.dumps(messages)
        frontend.close()
        assert not sessions[-1].closed
        assert marker.comm_id in manager.comms, "closing the last notebook view must retain discovery"
        marker.handle_msg({"content": {"data": {"kind": "status"}}})
        assert messages[-1][1]["locked"] is True
        marker.handle_msg({"content": {"data": {"kind": "close"}}})
        assert sessions[-1].closed
        assert instance.session is None and instance.running_comm is None
        assert not manager.comms
        assert messages[-1][0] == "comm_close"
        assert shell.user_ns["python_value"] == 42
        instance.execute("ddb_value = 8")
        assert instance.running_comm.comm_id != marker.comm_id
        assert len(manager.comms) == 1
        instance.close()
    finally:
        del shell.kernel


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
    assert shell.run_cell("%%ddb\n1 + 1", store_history=False).result is None


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


@pytest.mark.parametrize("method, code", [
    ("execute", "writeToDatabase()"), ("ddb_session", ""), ("ddb_upload", '{"data": 42}'),
])
def test_pending_or_failed_configuration_cannot_run_previous_connection(magic, method, code):
    _, instance, sessions = magic
    run = getattr(instance, method)
    comm = Comm()
    instance.open_comm(comm, {})
    comm.receive({"kind": "prepare", "connectionId": "new-selection"})
    assert instance.state()["requestedId"] == "new-selection"
    with pytest.raises(UsageError, match="准备"):
        run(code)
    comm.receive({"kind": "configuration-error"})
    with pytest.raises(UsageError, match="所选连接"):
        run(code)
    assert not sessions
    comm.receive({"kind": "configure", "profile": PROFILE})
    run(code)
    assert len(sessions) == 1


@pytest.mark.parametrize("method, code", [
    ("execute", "writeToDatabase()"), ("ddb_session", ""), ("ddb_upload", '{"data": 42}'),
])
def test_notebook_bootstrap_waits_for_comm_configuration(magic, method, code):
    shell, instance, sessions = magic
    run = getattr(instance, method)
    instance.profile = None
    load_notebook_extension(shell)
    with pytest.raises(UsageError, match="准备"):
        run(code)
    assert not sessions
    instance.configure(PROFILE)
    run(code)
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
    assert "ddb_session" not in shell.magics_manager.magics["line"]
    assert "ddb_upload" not in shell.magics_manager.magics["line"]
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
