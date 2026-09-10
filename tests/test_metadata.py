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
