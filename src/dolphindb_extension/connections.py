"""Connection profiles, credentials, and short-lived WebSocket relay tickets."""

from __future__ import annotations

import asyncio
import hashlib
import ipaddress
import json
import os
import re
import secrets
import tempfile
import time
from contextlib import suppress
from pathlib import Path
from typing import Any
from uuid import UUID, uuid4

import keyring
from keyring.errors import KeyringError, PasswordDeleteError

AUTH_RESOURCE = "dolphindb-extension:connections"


class ConnectionError(Exception):
    """A safe, user-facing failure; never includes credentials or SDK errors."""

    def __init__(self, message: str, status: int = 400):
        super().__init__(message)
        self.status = status


def validate_profile(data: Any, connection_id: str) -> dict[str, Any]:
    if not isinstance(data, dict):
        raise ConnectionError("连接配置必须是 JSON 对象。")
    profile: dict[str, Any] = {"id": connection_id}
    for field, label, limit, default in (
        ("name", "连接名称", 80, ""),
        ("host", "服务器地址", 253, ""),
        ("username", "用户名", 128, ""),
    ):
        value = data.get(field, default)
        if not isinstance(value, str) or len(value) > limit or any(ord(c) < 32 for c in value):
            raise ConnectionError(f"{label}格式不正确，最多 {limit} 个字符。")
        profile[field] = value.strip()
    if not profile["name"] or not profile["host"]:
        raise ConnectionError("请填写连接名称和服务器地址。")
    host = profile["host"]
    if host.startswith("[") and host.endswith("]"):
        host = host[1:-1]
    try:
        ipaddress.ip_address(host)
    except ValueError:
        try:
            host = host.encode("idna").decode("ascii")
        except UnicodeError:
            raise ConnectionError("服务器地址格式不正确。") from None
        if not re.fullmatch(r"[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?", host):
            raise ConnectionError("服务器地址只填写 IP 或域名，不要包含协议、端口或路径。")
    profile["host"] = host
    for field, label, default, maximum in (
        ("port", "端口", 8848, 65535),
        ("timeout", "连接超时", 10, 60),
    ):
        value = data.get(field, default)
        if type(value) is not int or not 1 <= value <= maximum:
            raise ConnectionError(f"{label}必须是 1 到 {maximum} 的整数。")
        profile[field] = value
    for field in ("ssl", "rememberPassword"):
        value = data.get(field, False)
        if type(value) is not bool:
            raise ConnectionError("SSL 和记住密码选项必须为布尔值。")
        profile[field] = value
    if "password" in data and (
        not isinstance(data["password"], str) or len(data["password"]) > 4096 or "\0" in data["password"]
    ):
        raise ConnectionError("密码格式不正确。")
    return profile


class ProfileStore:
    """Atomically persist profiles and the non-secret keyring namespace they use."""

    def __init__(self, directory: Path):
        self.path = directory / "connections.json"
        self.credential_service: str | None = None

    def load(self) -> tuple[list[dict[str, Any]], str | None]:
        if not self.path.exists():
            return [], None
        try:
            saved = json.loads(self.path.read_text(encoding="utf-8"))
            if saved["version"] != 1 or not isinstance(saved["connections"], list):
                raise ValueError("Unknown configuration format")
            service = saved.get("credentialService")
            if service is not None and (
                not isinstance(service, str) or not re.fullmatch(r"dolphindb-extension/[0-9a-f]{24}", service)
            ):
                raise ValueError("Invalid credential namespace")
            self.credential_service = service
            profiles = []
            for entry in saved["connections"]:
                connection_id = str(UUID(entry["id"]))
                profiles.append(validate_profile(entry, connection_id))
            ids = {p["id"] for p in profiles}
            if len(ids) != len(profiles):
                raise ValueError("Duplicate IDs")
            active = saved.get("activeId")
            return profiles, active if active in ids else None
        except (OSError, ValueError, KeyError, TypeError, ConnectionError):
            raise ConnectionError(
                "无法读取连接配置。请检查连接配置目录中的 connections.json。", 500
            ) from None

    def save(self, profiles: list[dict[str, Any]], active: str | None) -> None:
        temporary: str | None = None
        try:
            self.path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
            fd, temporary = tempfile.mkstemp(dir=self.path.parent, prefix=".connections-")
            with os.fdopen(fd, "w", encoding="utf-8") as handle:
                json.dump(
                    {
                        "version": 1,
                        "connections": profiles,
                        "activeId": active,
                        "credentialService": self.credential_service,
                    },
                    handle,
                    ensure_ascii=False,
                    indent=2,
                )
                handle.write("\n")
                handle.flush()
                os.fsync(handle.fileno())
            os.replace(temporary, self.path)
        except OSError:
            raise ConnectionError("无法保存连接配置，请检查连接配置目录的写入权限。", 500) from None
        finally:
            if temporary and os.path.exists(temporary):
                os.unlink(temporary)

    def migrate_from(self, directory: Path) -> bool:
        """Copy a legacy store once, retaining the original and its keyring identity."""
        source = ProfileStore(directory)
        if self.path.exists() or not source.path.exists():
            return False
        profiles, active = source.load()
        self.credential_service = source.credential_service or Credentials(directory).service
        self.save(profiles, active)
        return True


class Credentials:
    """Keep passwords in memory unless the user opts into the OS keyring."""

    def __init__(self, directory: Path, service: str | None = None):
        namespace = hashlib.sha256(str(directory.resolve()).encode()).hexdigest()[:24]
        self.service = service or f"dolphindb-extension/{namespace}"
        self.memory: dict[str, str] = {}

    @property
    def available(self) -> bool:
        try:
            return keyring.get_keyring().priority > 0
        except Exception:
            return False

    def get(self, profile: dict[str, Any], *, missing_ok: bool = False) -> str:
        if profile["id"] in self.memory:
            return self.memory[profile["id"]]
        if profile["rememberPassword"]:
            try:
                password = keyring.get_password(self.service, profile["id"])
            except KeyringError:
                raise ConnectionError("无法读取系统凭据库，请解锁凭据库或重新输入密码。") from None
            if password is None:
                if missing_ok:
                    return ""
                raise ConnectionError("未找到已保存的密码，请编辑连接并重新输入。")
            return password
        return ""

    def set(self, profile: dict[str, Any], password: str, previous: dict[str, Any] | None) -> None:
        try:
            if profile["rememberPassword"]:
                if not self.available:
                    raise ConnectionError("系统凭据库不可用。请取消“记住密码”，本次会话仍可使用密码连接。")
                keyring.set_password(self.service, profile["id"], password)
            elif previous and previous["rememberPassword"]:
                self._delete_saved(profile["id"])
        except KeyringError:
            raise ConnectionError("无法更新系统凭据库。请解锁凭据库或取消“记住密码”。") from None
        self.memory[profile["id"]] = password

    def _delete_saved(self, connection_id: str) -> None:
        with suppress(PasswordDeleteError):
            keyring.delete_password(self.service, connection_id)

    def delete(self, profile: dict[str, Any]) -> None:
        if profile["rememberPassword"]:
            try:
                self._delete_saved(profile["id"])
            except KeyringError:
                raise ConnectionError("无法从系统凭据库删除密码，请解锁凭据库后重试。") from None
        self.memory.pop(profile["id"], None)


class ConnectionManager:
    """Configuration and relay tickets; the upstream JS SDK owns actual DDB sessions."""

    def __init__(self, directory: Path, *, legacy_directory: Path | None = None):
        self.store = ProfileStore(directory)
        self.migrated = bool(legacy_directory and self.store.migrate_from(legacy_directory))
        self.profiles, self.active_id = self.store.load()
        self.credentials = Credentials(directory, self.store.credential_service)
        self.store.credential_service = self.credentials.service
        self.lock = asyncio.Lock()
        self.tickets: dict[str, tuple[float, dict[str, Any]]] = {}
        self.sockets: set[Any] = set()

    def snapshot(self) -> dict[str, Any]:
        return {
            "connections": [
                {**p, "hasPassword": bool(self.credentials.memory.get(p["id"])) or p["rememberPassword"]}
                for p in self.profiles
            ],
            "activeId": self.active_id,
            "credentialStorage": self.credentials.available,
        }

    def find(self, connection_id: str) -> dict[str, Any]:
        for profile in self.profiles:
            if profile["id"] == connection_id:
                return profile
        raise ConnectionError("连接不存在，请刷新列表。", 404)

    def close_sockets(self, connection_id: str) -> None:
        for socket in list(self.sockets):
            if socket.profile["id"] == connection_id:
                socket.close(code=1000, reason="Connection configuration changed")
        self.tickets = {k: v for k, v in self.tickets.items() if v[1]["id"] != connection_id}

    async def save(self, data: Any, connection_id: str | None = None) -> dict[str, Any]:
        async with self.lock:
            previous = self.find(connection_id) if connection_id else None
            profile = validate_profile(data, connection_id or str(uuid4()))
            if any(
                p["name"].casefold() == profile["name"].casefold() and p["id"] != profile["id"]
                for p in self.profiles
            ):
                raise ConnectionError("连接名称已存在，请使用其他名称。", 409)
            # An explicitly supplied empty password clears the credential; omission keeps it.
            old_password = self.credentials.get(previous, missing_ok=True) if previous else ""
            password = data.get("password", old_password)
            self.credentials.set(profile, password, previous)
            profiles = [profile if p["id"] == profile["id"] else p for p in self.profiles]
            if not previous:
                profiles.append(profile)
            try:
                self.store.save(profiles, self.active_id)
            except ConnectionError:
                if previous:
                    self.credentials.set(previous, old_password, profile)
                else:
                    self.credentials.delete(profile)
                raise
            self.profiles = profiles
            if previous and (
                any(previous[f] != profile[f] for f in ("host", "port", "username", "ssl", "timeout"))
                or password != old_password
            ):
                self.close_sockets(profile["id"])
            return self.snapshot()

    async def delete(self, connection_id: str) -> dict[str, Any]:
        async with self.lock:
            profile = self.find(connection_id)
            password = self.credentials.get(profile, missing_ok=True)
            self.credentials.delete(profile)
            profiles = [p for p in self.profiles if p["id"] != connection_id]
            active = None if connection_id == self.active_id else self.active_id
            try:
                self.store.save(profiles, active)
            except ConnectionError:
                self.credentials.set(profile, password, None)
                raise
            self.close_sockets(connection_id)
            self.profiles, self.active_id = profiles, active
            return self.snapshot()

    async def select(self, connection_id: str) -> dict[str, Any]:
        async with self.lock:
            self.find(connection_id)
            self.store.save(self.profiles, connection_id)
            self.active_id = connection_id
            return self.snapshot()

    async def prepare(self, data: Any) -> dict[str, Any]:
        async with self.lock:
            if not isinstance(data, dict):
                raise ConnectionError("连接配置必须是 JSON 对象。")
            previous = self.find(data["id"]) if data.get("id") else None
            profile = validate_profile(
                {**(previous or {}), **data}, previous["id"] if previous else str(uuid4())
            )
            password = (
                data["password"]
                if "password" in data
                else (self.credentials.get(previous) if previous else "")
            )
            now = time.monotonic()
            self.tickets = {k: v for k, v in self.tickets.items() if now - v[0] < 30}
            if len(self.tickets) >= 100 or len(self.sockets) >= 100:
                raise ConnectionError("连接请求过多，请稍后重试。", 429)
            ticket = secrets.token_urlsafe(32)
            self.tickets[ticket] = (now, profile)
            # Secrets are returned only for this authenticated connection attempt, never in lists.
            return {
                "path": f"dolphindb-extension/ws/{ticket}",
                "username": profile["username"],
                "password": password,
                "timeout": profile["timeout"],
            }

    def consume_ticket(self, ticket: str) -> dict[str, Any]:
        value = self.tickets.pop(ticket, None)
        if value is None or time.monotonic() - value[0] >= 30:
            raise ConnectionError("连接请求已过期，请重新连接。", 404)
        return value[1]

    def close(self) -> None:
        for socket in list(self.sockets):
            socket.close(code=1001, reason="Jupyter server stopped")
        self.credentials.memory.clear()
        self.tickets.clear()
