import json
from pathlib import Path
from types import SimpleNamespace

import numpy as np
import pandas as pd
import pytest

from dolphindb_extension.browser import FIRST_PAGE, ResultBrowser, session_page, value_page
from dolphindb_extension.connections import ConnectionError
from dolphindb_extension.dos_sessions import DosSession, validated_history_options
from dolphindb_extension.metadata import inspect_session
from dolphindb_extension.preferences import RUNTIME_FIELDS, resolve_runtime_settings


def test_runtime_settings_use_the_same_defaults_and_bounds_as_settings_editor():
    schema = json.loads((Path(__file__).parents[1] / "schema/settings.json").read_text(encoding="utf-8"))
    for group, fields in RUNTIME_FIELDS.items():
        for name, (default, minimum, maximum) in fields.items():
            field = schema["properties"][group]["properties"][name]
            assert (field["default"], field["minimum"], field["maximum"]) == (default, minimum, maximum)
            for value in (minimum, maximum):
                assert resolve_runtime_settings({group: {name: value}})[group][name] == value
            for value in (minimum - 1, maximum + 1, True, "10", 1.2):
                with pytest.raises(ValueError):
                    resolve_runtime_settings({group: {name: value}})


def test_explicit_notebook_browser_applies_requested_pages_and_cache_limits():
    browser = ResultBrowser()
    browser.configure({"dataBrowser": {"pageSize": 13, "columnPageSize": 2}, "advanced": {"cacheEntries": 1}})
    first = pd.DataFrame({str(c): np.arange(60) for c in range(6)})
    ticket = browser.ticket(first)
    target, request, initial = ticket["target"], ticket["initialRequest"], ticket["initial"]
    assert len(initial["grid"]["rows"]) == 13
    assert len(initial["grid"]["columns"]) == 3
    page = value_page(first, {**request, "columnOffset": 2})
    assert page["grid"]["columns"] == ["索引", "2", "3"]
    browser.ticket(first.copy())
    with pytest.raises(ValueError, match="expired"):
        browser.read(target, FIRST_PAGE)
    assert len(browser.results) == 1


def test_preview_settings_change_queries_and_enforce_live_variable_limit():
    queries = []
    session = SimpleNamespace(run=lambda code: queries.append(code) or pd.DataFrame({"x": [1]}))
    settings = {"preview": {"tableRows": 250}, "advanced": {"variablePreviewBytes": 2048}}
    inspect_session(session, "tablePreview", {"database": "dfs://test", "table": "prices"}, settings)
    assert "select top 250" in queries[-1]
    inspect_session(session, "variablePreview", {"name": "prices"}, settings)
    assert "> 2048" in queries[-1]
    with pytest.raises(ValueError):
        inspect_session(session, "tablePreview", {"database": "dfs://test", "table": "prices"}, {"preview": {"tableRows": "1;dropDatabase()"}})


def test_remote_column_page_width_matches_the_requested_range():
    queries = []
    def run(code):
        queries.append(code)
        return [6, 60, 6, 0] if code.startswith("(def(x)") else pd.DataFrame({"c2": [1], "c3": [2]})
    page = session_page(SimpleNamespace(run=run), {"kind": "variable", "name": "t"}, {**FIRST_PAGE, "columnOffset": 2, "columnLimit": 2})
    assert "2:4" in queries[-1]
    assert len(page["grid"]["columns"]) == 3


def test_session_history_settings_trim_counts_and_frames_without_resetting_the_session():
    model = DosSession("owner", "a.dos", {}, "")
    identifier = model.id
    model.history = [{"id": i, "frames": ["x" * 600000], "truncated": False} for i in range(3)]
    model.configure_history(*validated_history_options({"historyEntries": 2, "historyMegabytes": 1}))
    assert [run["id"] for run in model.history] == [2]
    assert model.id == identifier
    model.history[0]["frames"].append("y" * 600000)
    model.trim_history()
    assert model.history[0]["truncated"] and model.history[0]["frames"] == []
    with pytest.raises(ConnectionError):
        validated_history_options({"historyEntries": 0})
