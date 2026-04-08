import asyncio
import logging
import os
from typing import Any
from urllib.parse import quote

import aiohttp

logger = logging.getLogger(__name__)


def _first_non_empty(*values: Any) -> str:
    for value in values:
        if value is None:
            continue
        text = str(value).strip()
        if text:
            return text
    return ""


def _parse_optional_int(value: Any) -> int | None:
    if isinstance(value, bool) or value is None:
        return None
    if isinstance(value, int):
        return value
    text = str(value).strip()
    if text.startswith("-"):
        text = text[1:]
    if text.isdigit():
        return int(str(value).strip())
    return None


def _extract_cookie_map(raw_cookie: str) -> dict[str, str]:
    cookies: dict[str, str] = {}
    for chunk in raw_cookie.split(";"):
        part = chunk.strip()
        if not part or "=" not in part:
            continue
        key, value = part.split("=", 1)
        key = key.strip()
        value = value.strip()
        if key and value:
            cookies[key] = value
    return cookies


def _pick_first_user(payload: Any) -> dict[str, Any] | None:
    if isinstance(payload, list):
        for item in payload:
            if isinstance(item, dict):
                return item
        return None
    if isinstance(payload, dict):
        return payload
    return None


def _collect_nested_dicts(payload: Any) -> list[dict[str, Any]]:
    result: list[dict[str, Any]] = []
    stack: list[Any] = [payload]
    seen: set[int] = set()

    while stack:
        current = stack.pop()
        current_id = id(current)
        if current_id in seen:
            continue
        seen.add(current_id)

        if isinstance(current, dict):
            result.append(current)
            for value in current.values():
                if isinstance(value, (dict, list)):
                    stack.append(value)
        elif isinstance(current, list):
            for item in current:
                if isinstance(item, (dict, list)):
                    stack.append(item)

    return result


def normalize_remnawave_user(payload: Any) -> dict[str, Any] | None:
    user = _pick_first_user(payload)
    if user is None:
        return None

    candidates = _collect_nested_dicts(user)

    email = _first_non_empty(*(candidate.get("email") for candidate in candidates)).lower()

    telegram_id = next(
        (
            value
            for value in (
                _parse_optional_int(candidate.get("telegramId") or candidate.get("telegram_id") or candidate.get("id"))
                for candidate in candidates
            )
            if value is not None
        ),
        None,
    )

    telegram_username = _first_non_empty(
        *(
            candidate.get("telegramUsername")
            or candidate.get("telegram_username")
            or candidate.get("telegramLogin")
            or candidate.get("telegram_login")
            or candidate.get("username")
            for candidate in candidates
        )
    )

    photo = _first_non_empty(
        *(
            candidate.get("photoUrl")
            or candidate.get("photo_url")
            or candidate.get("avatarUrl")
            or candidate.get("avatar_url")
            or candidate.get("avatar")
            or candidate.get("photo")
            or candidate.get("userpic")
            for candidate in candidates
        )
    )

    subscription_url = _first_non_empty(
        *(
            candidate.get("subscriptionUrl")
            or candidate.get("subscription_url")
            or candidate.get("url")
            for candidate in candidates
        )
    )

    return {
        "email": email or None,
        "telegram_id": telegram_id,
        "telegram_username": telegram_username or None,
        "photo": photo or None,
        "subscription_url": subscription_url or None,
        "raw": user,
    }


async def _fetch_remnawave_user(path: str, lookup_label: str, lookup_value: str | int) -> dict[str, Any] | None:
    base_url = str(os.getenv("REMNAWAVE_BASE_URL", "")).rstrip("/")
    token = str(os.getenv("REMNAWAVE_TOKEN", "")).strip()
    raw_cookie = str(os.getenv("REMNAWAVE_COOKIE", "")).strip()

    if not base_url or not token or not raw_cookie:
        logger.warning("REMNAWAVE_BASE_URL, REMNAWAVE_TOKEN, or REMNAWAVE_COOKIE not configured")
        return None

    headers = {"Authorization": f"Bearer {token}"}
    cookies = _extract_cookie_map(raw_cookie)
    if not cookies:
        logger.warning("REMNAWAVE_COOKIE is malformed")
        return None

    url = f"{base_url}{path}"
    try:
        async with aiohttp.ClientSession() as session:
            async with session.get(url, headers=headers, cookies=cookies, ssl=False) as response:
                if response.status == 404:
                    logger.info("Remnawave user not found for %s=%s", lookup_label, lookup_value)
                    return None
                if response.status != 200:
                    logger.warning(
                        "Remnawave returned status %s for %s=%s",
                        response.status,
                        lookup_label,
                        lookup_value,
                    )
                    return None

                data = await response.json()
                return normalize_remnawave_user(data.get("response"))
    except Exception as exc:
        logger.error("Error fetching Remnawave user for %s=%s: %s", lookup_label, lookup_value, exc)
        return None


async def get_user_by_telegram_id(telegram_id: int) -> dict[str, Any] | None:
    return await _fetch_remnawave_user(
        f"/api/users/by-telegram-id/{telegram_id}",
        "telegram_id",
        telegram_id,
    )


async def get_user_by_email(email: str) -> dict[str, Any] | None:
    normalized_email = email.strip().lower()
    return await _fetch_remnawave_user(
        f"/api/users/by-email/{quote(normalized_email, safe='')}",
        "email",
        normalized_email,
    )


def get_remnawave_user_sync(*, email: str | None = None, telegram_id: int | None = None) -> dict[str, Any] | None:
    if email:
        coroutine = get_user_by_email(email)
    elif telegram_id is not None:
        coroutine = get_user_by_telegram_id(telegram_id)
    else:
        return None

    loop = asyncio.new_event_loop()
    try:
        asyncio.set_event_loop(loop)
        return loop.run_until_complete(coroutine)
    finally:
        loop.close()
