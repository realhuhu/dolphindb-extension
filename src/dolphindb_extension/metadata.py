"""Read-only language and workspace metadata in the owning kernel session."""

import json


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
