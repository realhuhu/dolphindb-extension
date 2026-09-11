import json

import pandas as pd
import pytest

from dolphindb_extension.metadata import inspect_session


class MetadataSession:
    def __init__(self):
        self.calls = []

    def run(self, code):
        self.calls.append(code)
        if code == "objs(true)":
            return pd.DataFrame([{"name": "ownTable", "form": "TABLE", "type": "ANY"}])
        if code.startswith("schema("):
            return ["id", "price"]
        if code.startswith("getSchemaByCatalog("):
            return pd.DataFrame([{"schema": "schemaA", "dbUrl": "dfs://market"}])
        if code.startswith("listTables("):
            return pd.DataFrame([{"tableName": "ticks"}])
        return ["dfs://market"]


def test_metadata_snapshot_contains_only_names_and_types():
    session = MetadataSession()
    data = inspect_session(session, "snapshot", {})
    assert data["variables"] == [{"name": "ownTable", "form": "TABLE", "type": "ANY"}]
    assert data["sharedTables"] == ["ownTable"]
    assert len(session.calls) == 3


@pytest.mark.parametrize("arguments", [
    {"kind": "variable", "name": "ownTable"},
    {"kind": "dfs", "database": "dfs://market", "table": "ticks"},
    {"kind": "catalog", "catalog": "cat", "schema": "schemaA", "table": "ticks"},
])
def test_column_metadata_uses_only_explicit_table_references(arguments):
    session = MetadataSession()
    assert inspect_session(session, "columns", arguments) == ["id", "price"]
    assert all(code.startswith(("schema(", "getSchemaByCatalog(")) for code in session.calls)


def test_metadata_quotes_names_and_rejects_operations_instead_of_evaluating_editor_code():
    session = MetadataSession()
    inspect_session(session, "columns", {"kind": "variable", "name": 't); evil(); "'})
    literal = session.calls[0].removeprefix("schema(objByName(").removesuffix(")).colDefs.name")
    assert json.loads(literal) == 't); evil(); "'
    session.calls.clear()
    with pytest.raises(ValueError):
        inspect_session(session, "run", {"code": "evil()"})
    assert session.calls == []


class WorkspaceSession:
    def __init__(self, failed=False):
        self.calls = []
        self.failed = failed

    def run(self, code):
        self.calls.append(code)
        if code == "getClusterDFSTables()":
            if self.failed:
                raise RuntimeError("private server details")
            return ["dfs://market/prices"]
        if code == "getClusterDFSDatabases()":
            return ["dfs://market", "dfs://empty"]
        if code == "getAllCatalogs()":
            return []
        if code == "objs(true)":
            return pd.DataFrame([
                {"name": "counter", "form": "SCALAR", "type": "INT", "rows": 1, "columns": 1, "bytes": 4, "shared": False},
                {"name": "prices", "form": "TABLE", "type": "ANY", "rows": 10**9, "columns": 2, "bytes": 2**63, "shared": False},
            ])
        if code.startswith("substr("):
            return "7"
        if code.startswith("select top 100"):
            return pd.DataFrame({"id": [1, 2], "price": [10, 20]})
        raise AssertionError(code)


def test_workspace_preview_keeps_empty_databases_without_fetching_variables():
    session = WorkspaceSession()
    data = inspect_session(session, "workspace", {"includeVariables": "false"})
    assert data["databases"] == [{"path": "dfs://empty", "tables": []}, {"path": "dfs://market", "tables": ["prices"]}]
    assert data["variables"] == []
    assert "objs(true)" not in session.calls


def test_workspace_reads_scalars_but_never_materializes_large_tables():
    session = WorkspaceSession()
    data = inspect_session(session, "workspace", {"includeVariables": "true"})
    assert data["variables"][0]["value"] == "7"
    assert data["variables"][1]["rows"] == 10**9
    assert "value" not in data["variables"][1]
    assert sum("objByName" in call for call in session.calls) == 1
    json.dumps(data)  # Native numpy integers must not leak into comm JSON.


def test_workspace_database_failure_does_not_hide_session_variables():
    data = inspect_session(WorkspaceSession(failed=True), "workspace", {"includeVariables": "true"})
    assert data["databaseError"] == "无法读取当前连接的数据库。"
    assert data["variables"][0]["name"] == "counter"
    assert data["variablesError"] is None


def test_table_preview_is_bounded_and_quotes_database_and_table_names():
    session = WorkspaceSession()
    data = inspect_session(session, "tablePreview", {"database": 'dfs://market"', "table": 't");evil();("'})
    assert session.calls == ['select top 100 * from loadTable("dfs://market\\\"", "t\\\");evil();(\\\"")']
    assert data == {"columns": ["id", "price"], "rows": [["1", "10"], ["2", "20"]],
                    "totalRows": 2, "sortRanks": [[0, 1], [0, 1]]}


def test_table_schema_reads_only_column_definitions_and_quotes_both_names():
    class Session:
        calls = []

        def run(self, code):
            self.calls.append(code)
            return pd.DataFrame({"name": [f"c{i}" for i in range(120)], "typeString": ["DECIMAL128"] * 120, "extra": [20] * 120})

    session = Session()
    database, table = 'dfs://a"b', 't");evil();("'
    data = inspect_session(session, "tableSchema", {"database": database, "table": table})
    assert session.calls == [f"schema(loadTable({json.dumps(database)}, {json.dumps(table)})).colDefs"]
    assert data["columns"] == ["name", "typeString", "extra"]
    assert data["rows"][0] == ["c0", "DECIMAL128", "20"]
    assert len(data["rows"]) == 100 and data["totalRows"] == 120


def test_table_schema_rejects_invalid_references_before_any_query():
    session = MetadataSession()
    with pytest.raises(ValueError):
        inspect_session(session, "tableSchema", {"database": "dfs://market", "table": ""})
    assert session.calls == []


def test_preview_sorting_uses_pandas_values_without_float_or_json_precision_loss():
    from decimal import Decimal

    from dolphindb_extension.metadata import _table_preview

    frame = pd.DataFrame({
        "price": [2.1, -2, 2.02, -10],
        "large": [2**63 - 1, 2**63 - 2, 1, -1],
        "decimal": [Decimal("2.00000000000000000001"), Decimal("2"), Decimal("-10"), None],
        "label": ["2", "10", "01", "11"],
    })
    data = _table_preview(frame)
    assert data["sortRanks"] == [[3, 1, 2, 0], [3, 2, 1, 0], [2, 1, 0, 3], [3, 1, 0, 2]]
    assert data["rows"][0][1] == str(2**63 - 1)
    json.dumps(data)


def test_variable_preview_quotes_names_and_checks_live_size_before_returning_a_single_value():
    class Session:
        def run(self, code):
            self.code = code
            return {"large_integer": 2**63 - 1, "items": [1, 2, 3]}

    session = Session()
    name = 'a");evil();("\\\nend'
    preview = inspect_session(session, "variablePreview", {"name": name})
    lines = session.code.splitlines()
    assert len(lines) == 3
    assert "first(bytes)" in lines[1] and "> 10240" in lines[1]
    assert json.loads(lines[2].removeprefix("objByName(").removesuffix(")")) == name
    assert preview["columns"] == ["键", "值"]
    assert preview["rows"] == [["large_integer", str(2**63 - 1)], ["items", "[1, 2, 3]"]]


def test_variable_preview_bounds_grids_and_text_without_changing_print_options():
    import numpy as np

    class Session:
        value = None

        def run(self, _code):
            return self.value

    session = Session()
    before = np.get_printoptions(), pd.get_option("display.max_rows")
    session.value = np.arange(1000)
    preview = inspect_session(session, "variablePreview", {"name": "v"})
    assert preview["columns"] == ["索引", "值"]
    assert preview["rows"] == [[str(i), str(i)] for i in range(10)]
    assert preview["totalRows"] == 1000
    session.value = pd.DataFrame({"id": range(100), "label": ["x"] * 100})
    table = inspect_session(session, "variablePreview", {"name": "t"})
    assert table["columns"] == ["id", "label"] and len(table["rows"]) == 10
    assert table["totalRows"] == 100
    session.value = "x" * 20_000
    assert len(inspect_session(session, "variablePreview", {"name": "v"})["text"]) == 8002
    assert (np.get_printoptions(), pd.get_option("display.max_rows")) == before


def test_variable_preview_preserves_matrix_orientation_labels_and_int64_precision():
    import numpy as np

    from dolphindb_extension.metadata import _variable_display

    matrix = [np.array([[2**63 - 1, 4], [2**63 - 2, -10]], dtype=np.int64), ["a", "b"], ["x", "y"]]
    preview = _variable_display(matrix)
    assert preview["columns"] == ["索引", "x", "y"]
    assert preview["rows"] == [["a", str(2**63 - 1), "4"], ["b", str(2**63 - 2), "-10"]]
    assert preview["sortRanks"] == [[0, 1], [1, 0], [1, 0]]
    large = _variable_display([np.arange(200).reshape(20, 10), None, None])
    assert len(large["rows"]) == 10 and len(large["columns"]) == 9
    assert large["totalRows"] == 20 and large["totalColumns"] == 11
    json.dumps(preview)


@pytest.mark.parametrize("value", [[1, 9], {1, 3, 5}, [], {}])
def test_variable_preview_pair_set_and_empty_values_are_structured(value):
    from dolphindb_extension.metadata import _variable_display

    preview = _variable_display(value)
    assert preview["columns"] == (["键", "值"] if isinstance(value, dict) else ["索引", "值"])
    assert len(preview["rows"]) == len(value) and preview["totalRows"] == len(value)


@pytest.mark.parametrize("name", ["", None, "a\0b", "x" * 2049])
def test_variable_preview_rejects_invalid_names_before_accessing_the_session(name):
    session = MetadataSession()
    with pytest.raises(ValueError):
        inspect_session(session, "variablePreview", {"name": name})
    assert session.calls == []
