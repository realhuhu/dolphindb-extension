"""Paged, read-only browsing of Python objects without replacing Session.run results."""

from __future__ import annotations

import json
import math
from collections import OrderedDict
from decimal import Decimal
from itertools import islice
from uuid import uuid4

from .preferences import resolve_runtime_settings

SHOW_MIME = "application/vnd.dolphindb.view+json"
FIRST_PAGE = {"path": [], "offset": 0, "limit": 100, "columnOffset": 0}
FORMS = {0: "SCALAR", 1: "VECTOR", 2: "PAIR", 3: "MATRIX", 4: "SET", 5: "DICT", 6: "TABLE", 7: "CHART", 8: "CHUNK", 9: "OBJECT", 10: "TENSOR"}


def validate_request(request):
    if not isinstance(request, dict):
        raise ValueError("Invalid browser request")
    path = request.get("path")
    def integer(n, maximum):
        return type(n) is int and 0 <= n <= maximum
    if not isinstance(path, list) or len(path) > 32 or not all(integer(n, 2**53 - 1) for n in path):
        raise ValueError("Invalid object path")
    if not integer(request.get("offset"), 2**53 - 1) or not integer(request.get("columnOffset"), 2**53 - 1):
        raise ValueError("Invalid offset")
    if not integer(request.get("limit"), 1000) or not request["limit"]:
        raise ValueError("Invalid page size")
    if not integer(request.get("columnLimit", 50), 200) or not request.get("columnLimit", 50):
        raise ValueError("Invalid column page size")
    if not integer(request.get("revision", 0), 2**53 - 1):
        raise ValueError("Invalid revision")
    return request


def _scalar(value):
    import numpy as np
    import pandas as pd

    if value is None or value is pd.NA or value is pd.NaT:
        return "null"
    if isinstance(value, (float, np.floating)) and not math.isfinite(value):
        return "null" if math.isnan(value) else str(value)
    if isinstance(value, (dict, list, tuple, set, np.ndarray, pd.DataFrame)):
        return _description(value)
    return str(value)


def _description(value):
    shape = getattr(value, "shape", None)
    return f"{type(value).__name__} {shape if shape is not None else len(value) if hasattr(value, '__len__') else ''}".strip()


def _type(values):
    import numpy as np
    if hasattr(values, "dtype") and values.dtype != object:
        return str(values.dtype)
    sample = next((item for item in islice(iter(values), 100) if item is not None), None)
    if isinstance(sample, np.ndarray) and sample.ndim == 1:
        return f"{_type(sample)}[]"
    return "DECIMAL" if isinstance(sample, Decimal) else "DOUBLE" if isinstance(sample, (float, np.floating)) else "OBJECT"


def _grid(frame):
    from .metadata import _table_preview

    result = _table_preview(frame)
    result["rows"] = [[_scalar(value) for value in row] for row in frame.itertuples(index=False, name=None)]
    result["columnTypes"] = [_type(frame.iloc[:, index]) for index in range(len(frame.columns))]
    return result


def _chart(value):
    import numpy as np

    data, row_labels, column_labels = value["data"]
    data = np.asarray(data)
    title = list(value.get("title", [])) + [""] * 4
    def finite(item):
        return float(item) if item is not None and math.isfinite(float(item)) else None
    result = {"type": int(value["chartType"]), "titles": dict(zip(("chart", "x_axis", "y_axis", "z_axis"), map(str, title[:4]))),
              "stacking": bool(value.get("stacking", False)), "multiY": bool(value.get("extras", {}).get("multiYAxes", False)),
              "rowLabels": list(range(len(data))) if row_labels is None else [_scalar(item) for item in row_labels],
              "columnLabels": list(map(str, range(data.shape[1]))) if column_labels is None else list(map(str, column_labels)),
              "values": [[finite(item) for item in row] for row in data]}
    for original, key in (("binCount", "binCount"), ("binStart", "binStart"), ("binEnd", "binEnd")):
        if original in value:
            result[key] = finite(value[original])
    return result


def value_page(value, request, form_hint=None):
    """Only the requested rows/columns are converted to JSON; integer text stays exact."""
    import numpy as np
    import pandas as pd

    validate_request(request)
    for index in request["path"]:
        tensor = isinstance(value, np.ndarray) and (value.ndim >= 2 or form_hint == "TENSOR")
        if isinstance(value, pd.DataFrame):
            value = value.iloc[:, index]
        elif isinstance(value, dict):
            value = next(islice(value.values(), index, index + 1))
        elif isinstance(value, pd.Series):
            value = value.iloc[index]
        elif isinstance(value, set):
            value = next(islice(iter(value), index, index + 1))
        else:
            value = value[index]
        form_hint = "TENSOR" if tensor else None
    if isinstance(value, np.ndarray) and value.ndim == 0:
        value = value.item()
    def labels(value, count):
        return value is None or isinstance(value, (np.ndarray, list, tuple, pd.Index, pd.Series)) and np.ndim(value) == 1 and len(value) == count
    matrix = (isinstance(value, list) and len(value) == 3 and isinstance(value[0], np.ndarray) and value[0].ndim == 2
              and labels(value[1], value[0].shape[0]) and labels(value[2], value[0].shape[1]))
    row_labels = column_labels = None
    if matrix:
        value, row_labels, column_labels = value
    elif isinstance(value, np.ndarray) and value.ndim >= 2:
        form_hint = "TENSOR"
    start, limit, col = request["offset"], request["limit"], request["columnOffset"]
    if isinstance(value, dict) and {"data", "chartType", "title"} <= value.keys():
        try:
            chart = _chart(value)
        except (TypeError, ValueError, IndexError, KeyError, OverflowError):
            pass  # Ordinary Python dictionaries may use these keys for unrelated data.
        else:
            return {"form": "CHART", "type": "CHART", "count": 1, "chart": chart}
    if isinstance(value, pd.DataFrame) or matrix:
        frame = value if isinstance(value, pd.DataFrame) else pd.DataFrame(value, columns=column_labels, index=row_labels)
        column_limit = request.get("columnLimit", 50)
        selected = frame.iloc[start:start + limit, col:col + column_limit].copy()
        selected.insert(0, "索引", list(map(str, selected.index)), allow_duplicates=True)
        grid = _grid(selected)
        grid["totalRows"], grid["totalColumns"] = len(frame), len(frame.columns) + 1
        result = {"form": "MATRIX" if matrix else "TABLE", "type": "MATRIX" if matrix else "TABLE", "count": len(frame),
                  "columnCount": len(frame.columns), "grid": grid}
        if not matrix:
            result["children"] = [{"index": i, "label": str(frame.columns[i]), "description": str(frame.dtypes.iloc[i])}
                                  for i in range(col, min(col + column_limit, len(frame.columns)))]
        return result
    if isinstance(value, np.ndarray) and (value.ndim > 1 or form_hint == "TENSOR"):
        shape = list(value.shape)
        if not shape:
            return {"form": "SCALAR", "type": str(value.dtype), "count": 1, "text": _scalar(value.item())}
        result = {"form": "TENSOR", "type": str(value.dtype), "shape": shape, "count": len(value)}
        indexes = range(start, min(start + limit, len(value)))
        if value.ndim > 1:
            result["children"] = [{"index": i, "label": f"[{i}]", "description": f"{value.dtype}{list(value.shape[1:])}"} for i in indexes]
        else:
            result["grid"] = _grid(pd.DataFrame({"索引": list(indexes), "值": value[start:start + limit]}))
            result["grid"]["totalRows"] = len(value)
        return result
    if isinstance(value, dict):
        items = list(islice(value.items(), start, start + limit))
        grid = _grid(pd.DataFrame({"键": pd.Series([key for key, _ in items], dtype=object), "值": pd.Series([item for _, item in items], dtype=object)}))
        grid["totalRows"] = len(value)
        return {"form": "DICT", "type": "DICTIONARY", "count": len(value), "grid": grid,
                "children": [{"index": start + i, "label": _scalar(key), "description": _description(item)} for i, (key, item) in enumerate(items)]}
    if isinstance(value, (list, tuple, set, np.ndarray, pd.Series)):
        selected = value.iloc[start:start + limit] if isinstance(value, pd.Series) else None
        items = list(selected) if selected is not None else list(islice(iter(value), start, start + limit))
        indexes = list(map(str, selected.index)) if selected is not None else list(range(start, start + len(items)))
        frame = pd.DataFrame({"索引": indexes, "值": pd.Series(items, dtype=object)})
        grid = _grid(frame)
        grid["columnTypes"][1] = _type(value)
        grid["totalRows"] = len(value)
        return {"form": form_hint or ("SET" if isinstance(value, set) else "VECTOR"), "type": _type(value), "count": len(value), "grid": grid,
                "children": [{"index": start + i, "label": str(indexes[i]), "description": _description(item)} for i, item in enumerate(items)
                             if isinstance(item, (list, tuple, dict, set, np.ndarray, pd.DataFrame))]}
    return {"form": "SCALAR", "type": type(value).__name__, "count": 1, "text": _scalar(value),
            "numeric": isinstance(value, (float, np.floating, Decimal))}


def target_expression(target):
    if not isinstance(target, dict):
        raise ValueError("Invalid browse target")

    def literal(key):
        value = target.get(key)
        if not isinstance(value, str) or len(value) > 4096 or "\x00" in value:
            raise ValueError("Invalid browse name")
        return json.dumps(value, ensure_ascii=False)

    kind = target.get("kind")
    if kind in ("variable", "variable-schema"):
        expression = f"objByName({literal('name')})"
        return f"schema({expression})" if kind == "variable-schema" else expression
    if kind == "database-schema":
        return f"schema(database({literal('database')}))"
    if kind in ("table", "schema"):
        expression = f"loadTable({literal('database')}, {literal('table')})"
        return f"schema({expression})" if kind == "schema" else expression
    raise ValueError("Unknown browse target")


def _metadata_query(expression):
    # size() on a DFS handle does not count the rows stored in its partitions.
    return f"(def(x){{f=form(x);r=1;c=0;if(f in [1,2,4,5]){{r=size(x)}};if(f==3){{r=rows(x);c=cols(x)}};if(f==6){{r=exec count(*) from x;c=cols(x)}};return [long(f),long(r),long(c),long(type(x))]}})({expression})"


def _table_query(expression, offset, limit, first_column, end_column):
    # Select named columns on the server, with an exclusive-end limit pair.
    # A positive range also works for empty tables and preserves their schema.
    return f"(def(t){{return sql(select=sqlCol(columnNames(t)[{first_column}:{end_column}]),from=t,limit={offset}:{offset + limit}).eval()}})({expression})"


def session_page(session, target, request, cache=None):
    validate_request(request)
    expression = target_expression(target)
    if cache is None:
        cache = {}
    run = session.run
    if target["kind"] not in ("variable", "variable-schema") and int(run("getNodeType()")) == 2:
        nodes = session.run("exec name from getClusterPerf(true) where mode=0 and state=1")
        if not len(nodes):
            raise ValueError("No data node available")
        node = json.dumps(str(nodes[0]))
        def run(code):
            return session.run(f"rpc({node},parseExpr({json.dumps(code, ensure_ascii=False)}))")
    def cached(code):
        key = (id(session), request.get("revision", 0), code)
        if key not in cache:
            value = run(code)
            cache.clear()
            cache[key] = value
        return cache[key]

    if target["kind"] in ("schema", "database-schema", "variable-schema"):
        return value_page(cached(expression), request)
    depth = 0
    while depth < len(request["path"]):
        index = request["path"][depth]
        form = int(run(f"form({expression})"))
        if form == 10:
            return value_page(cached(expression), {**request, "path": request["path"][depth:]}, "TENSOR")
        if form == 6:
            _, rows, columns, _ = map(int, run(_metadata_query(expression)))
            if not 0 <= rows <= 2**53 - 1 or index >= columns:
                raise ValueError("Column no longer exists or object is too large")
            if depth == len(request["path"]) - 1:
                if request["offset"] > rows:
                    raise ValueError("Object size changed; refresh from the first page")
                table = run(_table_query(expression, request["offset"], request["limit"], index, index + 1))
                page = value_page(table.iloc[:, 0], {**request, "path": [], "offset": 0, "columnOffset": 0})
                page["count"] = rows
                if "grid" in page:
                    page["grid"]["totalRows"] = rows
                    for i, row in enumerate(page["grid"]["rows"]):
                        row[0] = str(request["offset"] + i)
                for child in page.get("children", []):
                    child["index"] += request["offset"]
                    child["label"] = str(child["index"])
                return page
            row = request["path"][depth + 1]
            if row >= rows:
                raise ValueError("Row no longer exists; refresh from the first page")
            expression = f"(def(t){{v=column({_table_query('t', row, 1, index, index + 1)},0);if(type(v)>=64 && type(v)<128){{return row(v,0)}};return v[0]}})({expression})"
            depth += 2
            continue
        dtype = int(run(f"type({expression})")) if form == 1 else 0
        expression = f"values({expression})[{index}]" if form == 5 else f"row({expression},{index})" if 64 <= dtype < 128 else f"({expression})[{index}]"
        depth += 1
    form, rows, columns, dtype = map(int, run(_metadata_query(expression)))
    if form in (7, 10):
        return value_page(cached(expression), {**request, "path": []}, FORMS[form])
    start, limit, col = request["offset"], request["limit"], request["columnOffset"]
    end, end_col = min(rows, start + limit), min(columns, col + request.get("columnLimit", 50))
    if (not all(0 <= n <= 2**53 - 1 for n in (rows, columns)) or start > rows
            or form in (3, 6) and col > columns or form == 6 and columns > 0 and col == columns):
        raise ValueError("Object size changed; refresh from the first page")
    code = expression
    if form == 6 and columns > 0:
        code = _table_query(expression, start, limit, col, end_col)
    elif form == 3:
        code = f"({expression})[{start}:{end},{col}:{end_col}]"
    elif form == 1 and 64 <= dtype < 128:
        code = f"row({expression},{start}:{end})"
    elif form in (1, 2):
        code = f"({expression})[{start}:{end}]"
    elif form == 4:
        code = f"keys({expression})[{start}:{end}]"
    paged = form in (1, 2, 3, 4, 5, 6)
    value = OrderedDict(zip(run(f"keys({expression})[{start}:{end}]"), run(f"values({expression})[{start}:{end}]"))) if form == 5 else run(code)
    page = value_page(value, {**request, "path": [], **({"offset": 0, "columnOffset": 0} if paged else {})}, FORMS.get(form))
    if paged:
        page["count"], page["form"] = rows, FORMS[form]
        if columns:
            page["columnCount"] = columns
        if "grid" in page:
            page["grid"]["totalRows"] = rows
            if columns:
                page["grid"]["totalColumns"] = columns + 1
            if page["grid"]["columns"][0] == "索引" and (form != 3 or value[1] is None):
                for i, row in enumerate(page["grid"]["rows"]):
                    row[0] = str(start + i)
        for child in page.get("children", []):
            child["index"] += col if form == 6 else start
    return page


class ResultBrowser:
    """Retain displayed Python objects without installing global display formatters."""

    def __init__(self):
        self.settings = resolve_runtime_settings({})
        self.owner = uuid4().hex
        self.results = OrderedDict()

    def ticket(self, value):
        options = self.settings["dataBrowser"]
        request = {**FIRST_PAGE, "limit": options["pageSize"], "columnLimit": options["columnPageSize"]}
        initial = value_page(value, request)
        identifier = uuid4().hex
        self.results[identifier] = value
        self.trim()
        title = initial.get("chart", {}).get("titles", {}).get("chart") or f"DolphinDB · {initial['form']}"
        return {"owner": self.owner, "target": {"kind": "result", "id": identifier}, "title": title,
                "initial": initial, "initialRequest": request}

    def configure(self, data):
        self.settings = resolve_runtime_settings(data)
        self.trim()

    def trim(self):
        def size(item, seen=None):
            seen = set() if seen is None else seen
            if id(item) in seen:
                return 0
            seen.add(id(item))
            if isinstance(item, dict):
                return sum(size(key, seen) + size(value, seen) for key, value in item.items())
            if isinstance(item, (tuple, list)):
                return sum(size(value, seen) for value in item)
            return int(getattr(item, "nbytes", 0)) or int(getattr(item, "__sizeof__", lambda: 1024)())
        retained = sum(size(item) for item in self.results.values())
        options = self.settings["advanced"]
        while len(self.results) > 1 and (len(self.results) > options["cacheEntries"] or retained > options["cacheMegabytes"] * 1024 * 1024):
            _, item = self.results.popitem(last=False)
            retained -= size(item)

    def read(self, target, request):
        self.trim()
        identifier = target.get("id")
        if identifier not in self.results:
            raise ValueError("Result expired; run the cell again")
        return value_page(self.results[identifier], request)

    def dispose(self):
        self.results.clear()
