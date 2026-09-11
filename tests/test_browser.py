import json
import os
from collections import OrderedDict
from decimal import Decimal
from types import SimpleNamespace
from uuid import uuid4

import numpy as np
import pandas as pd
import pytest
from IPython.core.interactiveshell import InteractiveShell
from traitlets.config import Config

from dolphindb_extension.browser import (
    FIRST_PAGE,
    ResultBrowser,
    session_page,
    target_expression,
    validate_request,
    value_page,
)


def query(**changes):
    return {**FIRST_PAGE, **changes}


def test_dataframe_pages_rows_columns_and_nested_column_without_losing_int64():
    frame = pd.DataFrame({f"c{i}": np.arange(240, dtype=np.int64) + 9007199254740993 for i in range(63)})
    page = value_page(frame, query(offset=200, columnOffset=50))
    assert (page["count"], page["columnCount"]) == (240, 63)
    assert len(page["grid"]["rows"]) == 40
    assert page["grid"]["columns"][1] == "c50"
    assert page["grid"]["rows"][0][:2] == ["200", "9007199254741193"]
    assert page["children"][0]["index"] == 50
    child = value_page(frame, query(path=[50], offset=200))
    assert child["form"] == "VECTOR"
    assert child["grid"]["rows"][0] == ["200", "9007199254741193"]


@pytest.mark.parametrize("index", [
    pd.Index(["AAPL", "MSFT", "MSFT", "GOOG"], name="symbol"),
    pd.date_range("2026-09-01", periods=4, tz="Asia/Shanghai", name="date"),
    pd.MultiIndex.from_tuples([("AAPL", 1), ("MSFT", 1), ("MSFT", 2), ("GOOG", 1)], names=["symbol", "day"]),
    pd.RangeIndex(10, 18, 2, name="original_row"),
])
def test_python_indexes_survive_paging_and_column_navigation(index):
    frame = pd.DataFrame({"price": [10, 20, 30, 40]}, index=index)
    original = frame.copy(deep=True)
    labels = index.tolist()
    expected = [[str(labels[1]), "20"], [str(labels[2]), "30"]]
    browser = ResultBrowser()
    ticket = browser.ticket(frame)
    assert ticket["initial"]["grid"]["rows"][0] == [str(labels[0]), "10"]
    for path in ([], [0]):
        page = browser.read(ticket["target"], query(path=path, offset=1, limit=2))
        assert page["grid"]["rows"] == expected
    assert value_page(frame["price"], query(offset=1, limit=2))["grid"]["rows"] == expected
    pd.testing.assert_frame_equal(frame, original)


def test_series_child_labels_keep_index_but_navigation_uses_position():
    values = pd.Series([np.array([1, 2]), np.array([3, 4])], index=["first", "second"])
    page = value_page(values, query(offset=1))
    assert page["children"] == [{"index": 1, "label": "second", "description": "ndarray (2,)"}]
    assert page["grid"]["rows"][0][0] == "second"
    assert value_page(values, query(path=[1, 0]))["text"] == "3"


@pytest.mark.skipif(not os.environ.get("DDB_TEST_HOST"), reason="Set DDB_TEST_HOST/USER/PASSWORD to run the live SDK regression")
def test_live_table_browser_uses_sql_for_dfs_pages_and_column_cells():
    import dolphindb as ddb

    session = ddb.session()
    assert session.connect(os.environ["DDB_TEST_HOST"], int(os.environ.get("DDB_TEST_PORT", "8848")),
                           os.environ["DDB_TEST_USER"], os.environ["DDB_TEST_PASSWORD"])
    database = f"dfs://ddb_extension_browser_test_{uuid4().hex}"
    literal, owned = json.dumps(database), False
    try:
        assert not session.run(f"existsDatabase({literal})")
        session.run(f"browserTestDb=database({literal}, VALUE, 0..2)")
        owned = True
        session.run("browserTestData=table(take(0,257) as part,0..256 as id,(0..256)+1000 as price);"
                    "browserTestDb.createPartitionedTable(browserTestData,`prices,`part).append!(browserTestData);"
                    "browserTestDb.createPartitionedTable(browserTestData,`empty,`part)")
        session.run(f"browserTestDfs=loadTable({literal},`prices)")
        assert session.run("size(browserTestDfs)") == 0  # A handle is not the table's actual row count.
        for target in ({"kind": "variable", "name": "browserTestData"},
                       {"kind": "variable", "name": "browserTestDfs"},
                       {"kind": "table", "database": database, "table": "prices"}):
            page = session_page(session, target, query(offset=200, columnOffset=1, columnLimit=1))
            assert (page["count"], page["columnCount"]) == (257, 3)
            assert page["grid"]["columns"] == ["索引", "id"]
            assert page["grid"]["rows"] == [[str(i), str(i)] for i in range(200, 257)]
            assert page["children"][0]["index"] == 1
            column = session_page(session, target, query(path=[2], offset=200))
            assert column["form"] == "VECTOR" and column["count"] == 257
            assert column["grid"]["rows"] == [[str(i), str(i + 1000)] for i in range(200, 257)]
            assert session_page(session, target, query(path=[2, 201]))["text"] == "1201"
            assert session_page(session, target, query(offset=257))["grid"]["rows"] == []
            with pytest.raises(ValueError, match="Column"):
                session_page(session, target, query(path=[3]))
            with pytest.raises(ValueError, match="Row"):
                session_page(session, target, query(path=[2, 257]))
        empty = {"kind": "table", "database": database, "table": "empty"}
        for path in ([], [2]):
            page = session_page(session, empty, query(path=path))
            assert page["count"] == 0 and page["grid"]["rows"] == []
        arrays = np.empty(3, dtype=object)
        arrays[:] = [np.array([1, 2]), np.array([3, 4, 5]), np.array([6, 7])]
        session.upload({"browserTestArrays": pd.DataFrame({"id": [1, 2, 3], "values": arrays})})
        target = {"kind": "variable", "name": "browserTestArrays"}
        page = session_page(session, target, query(path=[1], offset=1, limit=1))
        assert page["children"][0]["index"] == 1 and page["children"][0]["label"] == "1"
        assert session_page(session, target, query(path=[1, 1]))["grid"]["rows"] == [["0", "3"], ["1", "4"], ["2", "5"]]
        assert session_page(session, target, query(path=[1, 1, 1]))["text"] == "4"
    finally:
        try:
            if owned:
                session.run(f"dropDatabase({literal})")
        finally:
            session.close()


def test_dictionary_schema_retains_all_attributes_and_drills_into_coldefs():
    schema = OrderedDict(partitionColumnName=["date", "symbol"],
                         colDefs=pd.DataFrame({"name": ["date", "price"], "typeString": ["DATE", "DOUBLE"]}),
                         partitionSchema=[np.array([1, 2]), {"policy": "VALUE"}], custom="retained")
    root = value_page(schema, query())
    assert [child["label"] for child in root["children"]] == list(schema)
    assert value_page(schema, query(path=[1]))["grid"]["rows"][1] == ["1", "price", "DOUBLE"]
    assert value_page(schema, query(path=[2, 1, 0]))["text"] == "VALUE"
    assert value_page({"zero_dimensional": np.array(42)}, query(path=[0]))["text"] == "42"


def test_nested_sdk_matrix_keeps_labels_and_orientation():
    matrix = [np.arange(24).reshape(6, 4), np.array(list("abcdef")), np.array(list("wxyz"))]
    page = value_page({"matrix": matrix}, query(path=[0], offset=2, limit=1, columnOffset=1))
    assert page["form"] == "MATRIX"
    assert page["grid"]["columns"] == ["索引", "x", "y", "z"]
    assert page["grid"]["rows"] == [["c", "9", "10", "11"]]


def test_tensor_drill_preserves_noncontiguous_slices_and_numeric_types():
    tensor = np.arange(48, dtype=np.int64).reshape(2, 4, 6)[:, ::2, ::2] + 9007199254740993
    root = value_page(tensor, query())
    assert root["shape"] == [2, 2, 3]
    assert len(root["children"]) == 2
    leaf = value_page(tensor, query(path=[1, 1], offset=1))
    assert leaf["form"] == "TENSOR"
    assert leaf["grid"]["rows"] == [["1", "9007199254741031"], ["2", "9007199254741033"]]


def test_decimal_sorting_uses_original_values_and_keeps_display_precision():
    frame = pd.DataFrame({"p": [Decimal("9007199254740993.12345678901234567890"), Decimal("-1.005"), None]})
    grid = value_page(frame, query())["grid"]
    assert grid["columnTypes"][1] == "DECIMAL"
    assert grid["rows"][0][1] == "9007199254740993.12345678901234567890"
    assert grid["sortRanks"][1] == [1, 0, 2]
    assert grid["rows"][2][1] == "null"


def test_chart_normalizes_python_sdk_matrix_and_json_nulls():
    chart = {"chartType": 4, "title": np.array(["Price", "Date", "Value"]), "stacking": True,
             "data": [np.array([[1., np.nan], [2., 3.]]), np.array(["a", "b"]), np.array(["p", "q"])],
             "extras": {"multiYAxes": True}}
    page = value_page(chart, query())
    assert page["form"] == "CHART"
    assert page["chart"]["values"] == [[1., None], [2., 3.]]
    assert page["chart"]["multiY"] is True
    json.dumps(page, allow_nan=False)


@pytest.mark.parametrize("change", [{"path": ["0);evil()"]}, {"path": [True]}, {"path": [0] * 33},
                                    {"offset": -1}, {"offset": 0.5}, {"columnOffset": 2**53},
                                    {"limit": 0}, {"limit": 1001}, {"revision": True}])
def test_browse_requests_reject_noninteger_or_unbounded_selectors(change):
    with pytest.raises(ValueError):
        validate_request(query(**change))


def test_remote_dictionary_does_not_rehash_keys_before_child_navigation():
    calls = []

    def run(code):
        calls.append(code)
        if code.startswith("(def(x)"):
            return [5, 20, 0, 25]
        if code.startswith("keys("):
            return ["b", "a"]
        if code.startswith("values("):
            return [np.array([11, 12]), np.array([21, 22])]
        pytest.fail(f"Unexpected query: {code}")

    page = session_page(SimpleNamespace(run=run), {"kind": "variable", "name": "d"}, query(offset=18))
    assert [child["label"] for child in page["children"]] == ["b", "a"]
    assert [child["index"] for child in page["children"]] == [18, 19]
    assert calls[1:] == ['keys(objByName("d"))[18:20]', 'values(objByName("d"))[18:20]']
    assert "dict(" not in "\n".join(calls)


def test_schema_cache_is_scoped_to_session_revision_and_caches_full_structure():
    calls = []

    def run(code):
        calls.append(code)
        return {"all": np.arange(125)}

    session = SimpleNamespace(run=run)
    target = {"kind": "variable-schema", "name": 't");evil();("'}
    assert target_expression(target) == 'schema(objByName("t\\\");evil();(\\\""))'
    cache = {}
    session_page(session, target, query(), cache)
    child = session_page(session, target, query(path=[0], offset=100), cache)
    assert child["grid"]["rows"][0] == ["100", "100"]
    assert len(calls) == 1
    session_page(session, target, query(revision=1), cache)
    assert len(calls) == 2


def test_remote_array_vector_uses_row_selection_before_element_paging():
    calls = []

    def run(code):
        calls.append(code)
        if code.startswith("form("):
            return 1
        if code.startswith("type("):
            return 68
        if code.startswith("(def(x)"):
            return [1, 152, 0, 4]
        assert code == '(row(objByName("a"),1))[100:152]'
        return np.arange(251, 303)

    page = session_page(SimpleNamespace(run=run), {"kind": "variable", "name": "a"}, query(path=[1], offset=100))
    assert page["grid"]["rows"][0] == ["100", "251"]
    assert len(calls) == 4


def test_explicit_browser_leaves_all_native_formatters_and_python_displays_unchanged():
    shell = InteractiveShell(config=Config({"HistoryManager": {"enabled": False}}))
    formatters = dict(shell.display_formatter.formatters)
    browser = ResultBrowser()
    try:
        result = pd.DataFrame({"value": [1, 2]})
        native = shell.display_formatter.format(result)
        ticket = browser.ticket(result)
        assert shell.display_formatter.format(result) == native
        assert shell.display_formatter.formatters == formatters
        assert browser.results[ticket["target"]["id"]] is result
        assert browser.read(ticket["target"], query())["grid"]["rows"][1] == ["1", "2"]
        scalar = browser.ticket(7)
        assert shell.display_formatter.format(7)[0] == {"text/plain": "7"}
        assert browser.read(scalar["target"], query())["text"] == "7"
        assert browser.ticket(None)["initial"]["text"] == "null"
    finally:
        browser.dispose()
        assert shell.display_formatter.formatters == formatters
        shell.history_manager.end_session()


def test_snapshot_eviction_keeps_newest_without_losing_original_return_object():
    browser = ResultBrowser()
    first = np.array([1, 2])
    target = browser.ticket(first)["target"]
    for i in range(20):
        browser.ticket(np.array([i]))
    assert len(browser.results) == 20
    with pytest.raises(ValueError, match="expired"):
        browser.read(target, FIRST_PAGE)
