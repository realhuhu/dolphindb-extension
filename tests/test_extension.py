import pytest

from dolphindb_extension.extension import DolphinDBExtensionApp


@pytest.mark.parametrize("selection", ["default", "new", "legacy", "both"])
async def test_connection_directory_selection(tmp_path, monkeypatch, selection):
    monkeypatch.setattr("dolphindb_extension.extension.jupyter_config_dir", lambda: str(tmp_path / "config"))
    monkeypatch.setattr("dolphindb_extension.extension.jupyter_data_dir", lambda: str(tmp_path / "data"))
    app = DolphinDBExtensionApp()
    expected = tmp_path / "config" / "dolphindb-extension"
    if selection in ("legacy", "both"):
        app.data_dir = str(tmp_path / "legacy-override")
        expected = tmp_path / "legacy-override"
    if selection in ("new", "both"):
        app.connections_dir = str(tmp_path / "new-override")
        expected = tmp_path / "new-override"
    app.initialize_settings()
    try:
        assert app.manager.store.path == expected / "connections.json"
    finally:
        await app.stop_extension()
