import json
import time

import pytest

from dolphindb_extension.connections import ConnectionError, ConnectionManager, ProfileStore, validate_profile


@pytest.fixture
def data():
    return {
        "name": "Development",
        "host": "localhost",
        "port": 8848,
        "username": "tester",
        "password": "test-only-password",
    }


@pytest.fixture
def manager(tmp_path, monkeypatch):
    saved = {}
    monkeypatch.setattr("keyring.get_keyring", lambda: type("Backend", (), {"priority": 1})())
    monkeypatch.setattr("keyring.get_password", lambda service, user: saved.get((service, user)))
    monkeypatch.setattr(
        "keyring.set_password", lambda service, user, password: saved.__setitem__((service, user), password)
    )
    monkeypatch.setattr("keyring.delete_password", lambda service, user: saved.pop((service, user), None))
    manager = ConnectionManager(tmp_path)
    yield manager
    manager.close()


@pytest.mark.parametrize(
    "field,value",
    [
        ("name", ""),
        ("host", "http://localhost"),
        ("host", "localhost:8848"),
        ("port", 0),
        ("port", 65536),
        ("port", True),
        ("timeout", 61),
        ("ssl", "false"),
        ("password", None),
        ("username", "bad\nname"),
    ],
)
def test_invalid_profiles(data, field, value):
    with pytest.raises(ConnectionError):
        validate_profile({**data, field: value}, "test")


async def test_crud_and_secret_redaction(manager, data):
    result = await manager.save(data)
    profile = result["connections"][0]
    assert profile["hasPassword"]
    assert data["password"] not in json.dumps(result)
    assert data["password"] not in manager.store.path.read_text()
    await manager.save({**profile, "name": "Renamed"}, profile["id"])
    assert manager.credentials.get(manager.find(profile["id"])) == data["password"]
    await manager.select(profile["id"])
    assert ProfileStore(manager.store.path.parent).load()[1] == profile["id"]
    result = await manager.delete(profile["id"])
    assert result["connections"] == [] and result["activeId"] is None
    assert manager.credentials.memory == {}


async def test_remember_password_survives_restart_and_can_be_cleared(manager, data):
    profile = (await manager.save({**data, "rememberPassword": True}))["connections"][0]
    manager.credentials.memory.clear()
    assert manager.credentials.get(manager.find(profile["id"])) == data["password"]
    await manager.save({**profile, "password": "", "rememberPassword": False}, profile["id"])
    assert not manager.snapshot()["connections"][0]["hasPassword"]
    manager.credentials.memory.clear()
    assert manager.credentials.get(manager.find(profile["id"])) == ""


async def test_password_is_memory_only_by_default(manager, data):
    profile = (await manager.save(data))["connections"][0]
    other = ConnectionManager(manager.store.path.parent)
    try:
        assert not other.snapshot()["connections"][0]["hasPassword"]
        assert other.credentials.get(other.find(profile["id"])) == ""
    finally:
        other.close()


async def test_unavailable_keyring_does_not_create_profile(manager, data, monkeypatch):
    monkeypatch.setattr("keyring.get_keyring", lambda: type("Backend", (), {"priority": 0})())
    with pytest.raises(ConnectionError, match="凭据库不可用"):
        await manager.save({**data, "rememberPassword": True})
    assert not manager.profiles
    assert not manager.store.path.exists()


async def test_duplicate_name_and_unknown_selection_leave_current_unchanged(manager, data):
    profile = (await manager.save(data))["connections"][0]
    await manager.select(profile["id"])
    with pytest.raises(ConnectionError):
        await manager.save({**data, "name": data["name"].upper()})
    with pytest.raises(ConnectionError):
        await manager.select("missing")
    assert manager.active_id == profile["id"]


async def test_prepare_is_transient_does_not_select_and_ticket_is_single_use(manager, data):
    ticket = await manager.prepare(data)
    assert ticket["password"] == data["password"]
    assert manager.profiles == [] and manager.active_id is None
    assert data["password"] not in str(manager.tickets)
    key = ticket["path"].split("/")[-1]
    assert manager.consume_ticket(key)["host"] == data["host"]
    with pytest.raises(ConnectionError):
        manager.consume_ticket(key)


async def test_expired_ticket(manager, data):
    ticket = await manager.prepare(data)
    key = ticket["path"].split("/")[-1]
    manager.tickets[key] = (time.monotonic() - 31, manager.tickets[key][1])
    with pytest.raises(ConnectionError):
        manager.consume_ticket(key)


async def test_failed_write_rolls_back_credentials(manager, data, monkeypatch):
    profile = (await manager.save({**data, "rememberPassword": True}))["connections"][0]

    def fail(*args):
        raise ConnectionError("Cannot write")

    monkeypatch.setattr(manager.store, "save", fail)
    with pytest.raises(ConnectionError):
        await manager.save({**profile, "password": "new-test-password"}, profile["id"])
    manager.credentials.memory.clear()
    assert manager.credentials.get(manager.find(profile["id"])) == data["password"]


def test_corrupt_config_is_not_silently_overwritten(tmp_path):
    path = tmp_path / "connections.json"
    path.write_text("{broken", encoding="utf-8")
    with pytest.raises(ConnectionError):
        ConnectionManager(tmp_path)
    assert path.read_text() == "{broken"


def test_ipv6_and_hostname_validation(data):
    assert validate_profile({**data, "host": "[::1]"}, "test")["host"] == "::1"
    assert validate_profile({**data, "host": "db.example.com"}, "test")["host"] == "db.example.com"


async def test_missing_saved_password_can_be_replaced_or_deleted(manager, data, monkeypatch):
    profile = (await manager.save({**data, "rememberPassword": True}))["connections"][0]
    manager.credentials.memory.clear()
    monkeypatch.setattr("keyring.get_password", lambda service, user: None)
    with pytest.raises(ConnectionError, match="未找到"):
        await manager.prepare({"id": profile["id"]})
    await manager.save({**profile, "password": "replacement-test-secret"}, profile["id"])
    manager.credentials.memory.clear()
    await manager.delete(profile["id"])
    assert not manager.profiles


async def test_legacy_migration_preserves_selection_password_and_original(manager, data, tmp_path):
    profile = (await manager.save({**data, "rememberPassword": True}))["connections"][0]
    await manager.select(profile["id"])
    # Version 0.1.0a2 derived the keyring namespace from the old directory.
    saved = json.loads(manager.store.path.read_text(encoding="utf-8"))
    saved.pop("credentialService")
    manager.store.path.write_text(json.dumps(saved), encoding="utf-8")
    original = manager.store.path.read_bytes()
    manager.close()
    destination = tmp_path / "new-config"
    migrated = ConnectionManager(destination, legacy_directory=tmp_path)
    try:
        assert migrated.migrated
        assert migrated.active_id == profile["id"]
        assert migrated.credentials.get(migrated.find(profile["id"])) == data["password"]
        assert data["password"] not in migrated.store.path.read_text(encoding="utf-8")
        assert manager.store.path.read_bytes() == original
    finally:
        migrated.close()
    restarted = ConnectionManager(destination)
    try:
        assert restarted.credentials.get(restarted.find(profile["id"])) == data["password"]
    finally:
        restarted.close()


async def test_migration_never_overwrites_existing_destination(manager, data, tmp_path):
    await manager.save(data)
    destination = tmp_path / "configured"
    target = ProfileStore(destination)
    target.save([], None)
    original = target.path.read_bytes()
    migrated = ConnectionManager(destination, legacy_directory=tmp_path)
    try:
        assert not migrated.migrated
        assert not migrated.profiles
        assert target.path.read_bytes() == original
    finally:
        migrated.close()


def test_migration_does_not_hide_corruption_or_leave_partial_file(tmp_path, monkeypatch):
    source = tmp_path / "legacy"
    source.mkdir()
    path = source / "connections.json"
    path.write_text("{broken", encoding="utf-8")
    target = tmp_path / "config"
    with pytest.raises(ConnectionError):
        ConnectionManager(target, legacy_directory=source)
    assert not target.exists()
    path.write_text('{"version": 1, "connections": []}', encoding="utf-8")

    def fail_replace(*args):
        raise OSError("Write failed")

    monkeypatch.setattr("os.replace", fail_replace)
    with pytest.raises(ConnectionError, match="无法保存"):
        ConnectionManager(target, legacy_directory=source)
    assert not list(target.iterdir())
    assert path.exists()


def test_invalid_credential_namespace_is_rejected(tmp_path):
    (tmp_path / "connections.json").write_text(
        '{"version": 1, "connections": [], "credentialService": "unrelated-service"}', encoding="utf-8"
    )
    with pytest.raises(ConnectionError):
        ConnectionManager(tmp_path)
