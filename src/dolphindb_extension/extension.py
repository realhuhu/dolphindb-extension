"""Jupyter Server lifecycle integration."""

import atexit
from pathlib import Path

from jupyter_core.paths import jupyter_data_dir
from jupyter_server.extension.application import ExtensionApp
from traitlets import Unicode

from .connections import ConnectionManager
from .handlers import setup_handlers


class DolphinDBExtensionApp(ExtensionApp):
    name = "dolphindb_extension"
    data_dir = Unicode(
        "",
        config=True,
        help="Directory for non-secret DolphinDB connection profiles. Defaults to Jupyter's data directory.",
    )

    def initialize_settings(self):
        directory = Path(self.data_dir) if self.data_dir else Path(jupyter_data_dir()) / "dolphindb-extension"
        self.manager = ConnectionManager(directory)
        atexit.register(self.manager.close)

    def initialize_handlers(self):
        setup_handlers(self.serverapp.web_app, self.manager)

    async def stop_extension(self):
        self.manager.close()
        atexit.unregister(self.manager.close)
