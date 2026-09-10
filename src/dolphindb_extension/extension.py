"""Jupyter Server lifecycle integration."""

import atexit
from pathlib import Path

from jupyter_core.paths import jupyter_config_dir, jupyter_data_dir
from jupyter_server.extension.application import ExtensionApp
from traitlets import Unicode

from .connections import ConnectionManager
from .dos_handlers import setup_dos_handlers
from .dos_sessions import DosSessionManager
from .handlers import setup_handlers


class DolphinDBExtensionApp(ExtensionApp):
    name = "dolphindb_extension"
    connections_dir = Unicode(
        "",
        config=True,
        help="Directory for DolphinDB connection profiles. Defaults to <jupyter_config_dir>/dolphindb-extension.",
    )
    data_dir = Unicode(
        "",
        config=True,
        help="Deprecated alias for connections_dir. An explicit connections_dir takes precedence.",
    )

    def initialize_settings(self):
        explicit = self.connections_dir or self.data_dir
        directory = (
            Path(explicit).expanduser() if explicit else Path(jupyter_config_dir()) / "dolphindb-extension"
        )
        legacy = None if explicit else Path(jupyter_data_dir()) / "dolphindb-extension"
        self.manager = ConnectionManager(directory, legacy_directory=legacy)
        self.dos_manager = DosSessionManager(self.manager)
        if self.manager.migrated:
            self.log.info(
                "Migrated DolphinDB profiles to %s; the original is retained in %s", directory, legacy
            )
        atexit.register(self.manager.close)
        atexit.register(self.dos_manager.close)

    def initialize_handlers(self):
        setup_handlers(self.serverapp.web_app, self.manager)
        setup_dos_handlers(self.serverapp.web_app, self.dos_manager)

    async def stop_extension(self):
        self.dos_manager.close()
        atexit.unregister(self.dos_manager.close)
        self.manager.close()
        atexit.unregister(self.manager.close)
