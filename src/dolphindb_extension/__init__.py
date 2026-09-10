"""DolphinDB connection management for JupyterLab and Notebook."""

from importlib.metadata import version

__version__ = version("dolphindb-extension")


def _jupyter_labextension_paths():
    return [{"src": "labextension", "dest": "dolphindb-extension"}]


def _jupyter_server_extension_points():
    from .extension import DolphinDBExtensionApp

    return [{"module": "dolphindb_extension", "app": DolphinDBExtensionApp}]


def load_ipython_extension(ipython):
    """Enable %ddb / %%ddb in the current IPython kernel."""
    from .magics import load_ipython_extension as load

    load(ipython)


def unload_ipython_extension(ipython):
    from .magics import unload_ipython_extension as unload

    unload(ipython)
