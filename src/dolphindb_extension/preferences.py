"""Validated user preferences shared by the notebook and session broker."""

RUNTIME_FIELDS = {
    "dataBrowser": {"pageSize": (100, 1, 1000), "columnPageSize": (50, 1, 200)},
    "preview": {"tableRows": (100, 1, 1000)},
    "advanced": {
        "variablePreviewBytes": (10240, 1024, 1048576),
        "cacheEntries": (20, 1, 200), "cacheMegabytes": (64, 1, 1024),
        "historyEntries": (20, 1, 200), "historyMegabytes": (8, 1, 64),
    },
}


def resolve_runtime_settings(data):
    if not isinstance(data, dict):
        raise ValueError("Invalid DolphinDB settings")
    result = {}
    for group, fields in RUNTIME_FIELDS.items():
        values = data.get(group, {})
        if not isinstance(values, dict):
            raise ValueError(f"Invalid settings group: {group}")
        result[group] = {}
        for name, (default, minimum, maximum) in fields.items():
            value = values.get(name, default)
            if type(value) is not int or not minimum <= value <= maximum:
                raise ValueError(f"Invalid setting: {group}.{name}")
            result[group][name] = value
    return result


def history_options(data):
    settings = resolve_runtime_settings({"advanced": data})["advanced"]
    return settings["historyEntries"], settings["historyMegabytes"] * 1024 * 1024
