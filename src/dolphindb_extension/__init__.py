"""DolphinDB connection management for JupyterLab and Notebook."""

from importlib.metadata import version

__version__ = version("dolphindb-extension")


def _jupyter_labextension_paths():
    return [{"src": "labextension", "dest": "dolphindb-extension"}]


def _jupyter_server_extension_points():
    from .extension import DolphinDBExtensionApp

    return [{"module": "dolphindb_extension", "app": DolphinDBExtensionApp}]
