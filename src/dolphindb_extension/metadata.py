"""Read-only language and workspace metadata in the owning kernel session."""

import json
import pprint
from itertools import islice


def _variable_preview(session, name):
    # Same 10 KiB limit as upstream DdbVar.resolve_tooltip. Check inside the
    # evaluation, since a shared variable may have grown since the last snapshot.
    # Return a single object: putting mutable objects in an ANY vector loses ownership.
    value = session.run(
        f'if ((exec count(*) from objs(true) where name = {name}) == 0) throw "变量已不存在，请刷新变量面板。";\n'
        f'if ((exec first(bytes) from objs(true) where name = {name}) > 10240) throw "变量超过 10 KiB，请刷新变量面板。";\n'
        f'objByName({name})'
    )
    return _variable_display(value)


def _variable_display(value):
    """Serialize a bounded grid, retaining native values until after sorting."""
    import numpy as np
    import pandas as pd

    def grid(frame, total_rows, total_columns=None):
        result = _table_preview(frame)
        result["totalRows"] = total_rows
        if total_columns is not None:
            result["totalColumns"] = total_columns
        return result

    if isinstance(value, pd.DataFrame):
        return grid(value.iloc[:10, :8], len(value), len(value.columns))
    if isinstance(value, dict):
        items = list(islice(value.items(), 10))
        return grid(pd.DataFrame({"键": pd.Series([key for key, _ in items], dtype=object),
                                  "值": pd.Series([item for _, item in items], dtype=object)}), len(value))

    # DolphinDB's Python SDK returns matrices as [ndarray, row labels, column labels].
    row_labels = column_labels = None
    if isinstance(value, list) and len(value) == 3 and isinstance(value[0], np.ndarray) and value[0].ndim == 2:
        value, row_labels, column_labels = value
    if isinstance(value, np.ndarray) and value.ndim == 2:
        frame = pd.DataFrame(value[:10, :8], columns=None if column_labels is None else column_labels[:8])
        labels = list(range(len(frame))) if row_labels is None else row_labels[:10]
        frame.insert(0, "索引", pd.Series(labels, dtype=object), allow_duplicates=True)
        return grid(frame, value.shape[0], value.shape[1] + 1)
    if isinstance(value, (list, tuple, set)) or isinstance(value, np.ndarray) and value.ndim > 0:
        items = list(islice(value, 10))
        return grid(pd.DataFrame({"索引": range(len(items)), "值": pd.Series(items, dtype=object)}), len(value))

    with np.printoptions(threshold=50, edgeitems=3, linewidth=80), pd.option_context(
        "display.max_rows", 10, "display.max_columns", 8, "display.max_colwidth", 80, "display.width", 80
    ):
        text = str(value) if isinstance(value, (str, np.generic)) else pprint.pformat(value, width=80, depth=5, compact=True, sort_dicts=False)
    return {"text": text[:8000] + "\n…" if len(text) > 8000 else text}


def _strings(value):
    return [str(item) for item in value] if value is not None else []


def _records(value):
    return value.to_dict("records") if hasattr(value, "to_dict") else []


def _table_preview(table):
    # As in SQL result widgets, order the original data before serializing display text.
    # pandas retains INT64, Decimal and datetime precision here; JSON carries only ranks.
    sort_ranks = []
    for index in range(len(table.columns)):
        column = table.iloc[:, index].reset_index(drop=True)
        try:
            order = column.sort_values(kind="stable", na_position="last").index
            ranks = [0] * len(table)
            for rank, row in enumerate(order):
                ranks[int(row)] = rank
            sort_ranks.append(ranks)
        except (TypeError, ValueError):
            sort_ranks.append(None)  # Unordered values, such as arrays, retain a text fallback.
    return {"columns": [str(column) for column in table.columns],
            "rows": [[str(value)[:2000] for value in row] for row in table.itertuples(index=False, name=None)],
            "totalRows": len(table), "sortRanks": sort_ranks}


def _workspace(session, include_variables):
    data = {"databases": [], "variables": [], "databaseError": None, "variablesError": None}
    try:
        entries = {}
        tables = _strings(session.run("getClusterDFSTables()"))
        try:
            for path in _strings(session.run("getClusterDFSDatabases()")):
                entries[path.rstrip("/")] = {"path": path.rstrip("/"), "tables": []}
        except Exception:
            pass  # Older servers can still enumerate databases from the visible tables.
        for path in tables:
            database, _, table = path.rpartition("/")
            entries.setdefault(database, {"path": database, "tables": []})["tables"].append(table)
        try:
            for catalog in _strings(session.run("getAllCatalogs()")):
                for schema in _records(session.run(f"getSchemaByCatalog({json.dumps(catalog)})")):
                    if schema["dbUrl"] in entries:
                        entries[schema["dbUrl"]]["catalog"] = f"{catalog}.{schema['schema']}"
        except Exception:
            pass  # Catalogs are optional on older DolphinDB servers.
        data["databases"] = [entries[path] for path in sorted(entries)]
    except Exception:
        data["databaseError"] = "无法读取当前连接的数据库。"
    if include_variables:
        try:
            for row in _records(session.run("objs(true)")):
                variable = {key: str(row.get(key, "")) for key in ("name", "form", "type")}
                variable.update(rows=int(row.get("rows", 0)), columns=int(row.get("columns", 0)),
                                bytes=str(row.get("bytes", 0)), shared=bool(row.get("shared", False)))
                # Like the upstream explorer, never materialize vectors/tables just to display a value.
                if variable["form"] in ("SCALAR", "PAIR"):
                    try:
                        name = json.dumps(variable["name"], ensure_ascii=False)
                        variable["value"] = str(session.run(f"substr(string(objByName({name})), 0, 300)"))[:300]
                    except Exception:
                        pass
                data["variables"].append(variable)
        except Exception:
            data["variablesError"] = "无法读取当前 DDB 会话的变量。"
    return data


def inspect_session(session, operation: str, arguments: dict):
    def literal(key):
        value = arguments.get(key)
        if not isinstance(value, str) or not value or len(value) > 2048 or "\0" in value:
            raise ValueError("Invalid metadata argument")
        return json.dumps(value, ensure_ascii=False)

    def query(code, fallback):
        try:
            return session.run(code)
        except Exception:
            return fallback

    if operation == "workspace":
        return _workspace(session, arguments.get("includeVariables") == "true")
    if operation == "tablePreview":
        table = session.run(f"select top 100 * from loadTable({literal('database')}, {literal('table')})")
        if not hasattr(table, "columns") or not hasattr(table, "itertuples"):
            raise ValueError("Expected a table preview")
        return _table_preview(table)
    if operation == "tableSchema":
        schema = session.run(f"schema(loadTable({literal('database')}, {literal('table')})).colDefs")
        if not hasattr(schema, "columns") or not hasattr(schema, "itertuples"):
            raise ValueError("Expected a table schema")
        result = _table_preview(schema.iloc[:100])
        result["totalRows"] = len(schema)
        return result
    if operation == "variablePreview":
        return _variable_preview(session, literal("name"))

    if operation == "snapshot":
        variables = [{key: str(row.get(key, "")) for key in ("name", "form", "type")}
                     for row in _records(query("objs(true)", None))]
        return {
            "variables": variables,
            "sharedTables": [row["name"] for row in variables if row["form"] == "TABLE"],
            "databases": _strings(query("getClusterDFSDatabases()", [])),
            "catalogs": _strings(query("getAllCatalogs()", [])),
        }
    if operation == "tables":
        return [str(row["tableName"]) for row in _records(session.run(f"listTables({literal('database')})"))]
    if operation == "schemas":
        return [str(row["schema"]) for row in _records(session.run(f"getSchemaByCatalog({literal('catalog')})"))]
    if operation in ("schemaTables", "columns"):
        kind = arguments.get("kind", "catalog")
        if kind == "variable" and operation == "columns":
            expression = f"objByName({literal('name')})"
        else:
            if kind == "catalog":
                schemas = _records(session.run(f"getSchemaByCatalog({literal('catalog')})"))
                schema = arguments.get("schema")
                database = next((str(row["dbUrl"]) for row in schemas if row["schema"] == schema), None)
                if database is None:
                    return []
                db = json.dumps(database, ensure_ascii=False)
            elif kind == "dfs":
                db = literal("database")
            else:
                raise ValueError("Unsupported metadata reference")
            if operation == "schemaTables":
                return [str(row["tableName"]) for row in _records(session.run(f"listTables({db})"))]
            expression = f"loadTable({db}, {literal('table')})"
        return _strings(session.run(f"schema({expression}).colDefs.name"))
    raise ValueError("Unsupported metadata operation")
