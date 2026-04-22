import asyncio
import json
import os
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any
from urllib.parse import parse_qs

from asgiref.sync import async_to_sync
from django.contrib.auth.models import User

PING_INTERVAL_SECONDS = 25
MAX_QUEUE_SIZE = 128
WS_CHAT_PATH = "/ws/chat/"


def _parse_optional_int(value: str | None) -> int | None:
    if value is None:
        return None
    cleaned = value.strip()
    if not cleaned:
        return None
    if cleaned.startswith("-"):
        cleaned = cleaned[1:]
    if not cleaned.isdigit():
        return None
    return int(value.strip())


def _parse_admin_ids() -> set[int]:
    raw = os.getenv("VITE_ADMIN") or os.getenv("ADMIN") or ""
    normalized = raw.strip().strip("[]")
    if not normalized:
        return set()
    result: set[int] = set()
    for value in normalized.split(","):
        cleaned = value.strip()
        if cleaned.isdigit():
            result.add(int(cleaned))
    return result


def _is_admin_identity(user_id: int | None, telegram_id: int | None = None) -> bool:
    admin_ids = _parse_admin_ids()
    if user_id is not None and user_id in admin_ids:
        return True
    return telegram_id is not None and telegram_id in admin_ids


def _normalize_email(value: str) -> str:
    return value.strip().lower()


def _ws_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def is_chat_ws_path(path: str) -> bool:
    return path == WS_CHAT_PATH or path == WS_CHAT_PATH[:-1]


@dataclass(eq=False, slots=True)
class ChatWsConnection:
    user_id: int
    is_admin: bool
    queue: asyncio.Queue[dict[str, Any]]


def _can_receive_event(connection: ChatWsConnection, event: dict[str, Any]) -> bool:
    scope = str(event.get("scope", "")).strip()
    if scope != "private":
        return True
    if connection.is_admin:
        return True

    sender_id = _parse_optional_int(str(event.get("sender_id", "")).strip())
    recipient_id = _parse_optional_int(str(event.get("recipient_id", "")).strip())
    if sender_id is None and recipient_id is None:
        return False
    return connection.user_id in {sender_id, recipient_id}


class ChatRealtimeHub:
    def __init__(self) -> None:
        self._lock = asyncio.Lock()
        self._connections: set[ChatWsConnection] = set()

    async def register(self, connection: ChatWsConnection) -> None:
        async with self._lock:
            self._connections.add(connection)

    async def unregister(self, connection: ChatWsConnection) -> None:
        async with self._lock:
            self._connections.discard(connection)

    async def publish(self, event: dict[str, Any]) -> None:
        event_payload = dict(event)
        event_payload.setdefault("at", _ws_now())
        envelope = {"type": "chat_event", "event": event_payload}

        async with self._lock:
            connections = tuple(self._connections)

        for connection in connections:
            if not _can_receive_event(connection, event_payload):
                continue
            try:
                connection.queue.put_nowait(envelope)
            except asyncio.QueueFull:
                try:
                    _ = connection.queue.get_nowait()
                except asyncio.QueueEmpty:
                    pass
                try:
                    connection.queue.put_nowait(envelope)
                except asyncio.QueueFull:
                    # Connection is too slow; keep processing other clients.
                    continue


CHAT_REALTIME_HUB = ChatRealtimeHub()


def publish_chat_event(event: dict[str, Any]) -> None:
    try:
        async_to_sync(CHAT_REALTIME_HUB.publish)(event)
    except Exception:
        # Realtime delivery must never break the primary HTTP request.
        return


def _build_json_message(payload: dict[str, Any]) -> dict[str, str]:
    return {
        "type": "websocket.send",
        "text": json.dumps(payload, ensure_ascii=False, separators=(",", ":")),
    }


async def _resolve_websocket_user(query: dict[str, list[str]]) -> tuple[int | None, bool]:
    user_id = _parse_optional_int((query.get("user_id") or [""])[0])
    if user_id is None:
        return None, False

    user_exists = await User.objects.filter(id=user_id).aexists()
    if not user_exists:
        email = _normalize_email((query.get("email") or [""])[0])
        if not email:
            return None, False

        existing = await User.objects.filter(email__iexact=email).afirst()
        if existing is not None:
            user_id = int(existing.id)
        else:
            username = email
            suffix = 1
            while await User.objects.filter(username__iexact=username).aexists():
                suffix += 1
                username = f"{email}_{suffix}"
            created = User(username=username, email=email)
            created.set_unusable_password()
            await created.asave()
            user_id = int(created.id)

    telegram_id = _parse_optional_int((query.get("telegram_id") or [""])[0])
    return user_id, _is_admin_identity(user_id, telegram_id)


async def _sender_loop(send, connection: ChatWsConnection) -> None:
    while True:
        payload = await connection.queue.get()
        await send(_build_json_message(payload))


async def _ping_loop(connection: ChatWsConnection) -> None:
    while True:
        await asyncio.sleep(PING_INTERVAL_SECONDS)
        try:
            connection.queue.put_nowait({"type": "ping", "ts": _ws_now()})
        except asyncio.QueueFull:
            try:
                _ = connection.queue.get_nowait()
            except asyncio.QueueEmpty:
                pass


async def chat_ws_app(scope, receive, send) -> None:
    query_string = scope.get("query_string", b"")
    query = parse_qs(query_string.decode("utf-8", errors="ignore"))
    user_id, is_admin = await _resolve_websocket_user(query)
    if user_id is None:
        await send({"type": "websocket.close", "code": 4401})
        return

    await send({"type": "websocket.accept"})
    connection = ChatWsConnection(
        user_id=user_id,
        is_admin=is_admin,
        queue=asyncio.Queue(maxsize=MAX_QUEUE_SIZE),
    )
    await CHAT_REALTIME_HUB.register(connection)

    sender_task = asyncio.create_task(_sender_loop(send, connection))
    ping_task = asyncio.create_task(_ping_loop(connection))
    await connection.queue.put(
        {
            "type": "ready",
            "user_id": user_id,
            "is_admin": is_admin,
            "ts": _ws_now(),
        }
    )

    try:
        while True:
            message = await receive()
            message_type = message.get("type")
            if message_type == "websocket.disconnect":
                break
            if message_type != "websocket.receive":
                continue

            text = message.get("text")
            if not text:
                continue
            try:
                payload = json.loads(text)
            except json.JSONDecodeError:
                continue

            if str(payload.get("type", "")).strip().lower() == "ping":
                await connection.queue.put({"type": "pong", "ts": _ws_now()})
    finally:
        await CHAT_REALTIME_HUB.unregister(connection)
        sender_task.cancel()
        ping_task.cancel()
        await asyncio.gather(sender_task, ping_task, return_exceptions=True)
