import pytest

pytest_plugins = ["pytest_jupyter.jupyter_server"]


@pytest.fixture
def jp_server_config(tmp_path):
    return {
        "ServerApp": {"jpserver_extensions": {"dolphindb_extension": True}},
        "DolphinDBExtensionApp": {"connections_dir": str(tmp_path / "profiles")},
    }
