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


def _find_first_non_empty(candidates: list[dict[str, Any]], keys: tuple[str, ...]) -> str:
    for candidate in candidates:
        for key in keys:
            value = _first_non_empty(candidate.get(key))
            if value:
                return value
    return ""


def _find_first_optional_int(candidates: list[dict[str, Any]], keys: tuple[str, ...]) -> int | None:
    for candidate in candidates:
        for key in keys:
            value = _parse_optional_int(candidate.get(key))
            if value is not None:
                return value
    return None


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
    telegram_candidates: list[dict[str, Any]] = []
    regular_candidates: list[dict[str, Any]] = []
    stack: list[tuple[Any, bool]] = [(payload, False)]
    seen: set[int] = set()

    while stack:
        current, in_telegram_branch = stack.pop()
        current_id = id(current)
        if current_id in seen:
            continue
        seen.add(current_id)

        if isinstance(current, dict):
            key_names = tuple(str(key).lower() for key in current.keys())
            is_telegram_dict = in_telegram_branch or any("telegram" in key for key in key_names)

            if is_telegram_dict:
                telegram_candidates.append(current)
            else:
                regular_candidates.append(current)

            for key, value in current.items():
                if isinstance(value, (dict, list)):
                    stack.append((value, is_telegram_dict or ("telegram" in str(key).lower())))
        elif isinstance(current, list):
            for item in current:
                if isinstance(item, (dict, list)):
                    stack.append((item, in_telegram_branch))

    return telegram_candidates + regular_candidates


def normalize_remnawave_user(payload: Any) -> dict[str, Any] | None:
    user = _pick_first_user(payload)
    if user is None:
        return None

    candidates = _collect_nested_dicts(user)

    email = _find_first_non_empty(candidates, ("email",)).lower()

    telegram_id = _find_first_optional_int(
        candidates,
        ("telegramId", "telegram_id", "telegramID", "telegramUserId", "telegram_user_id", "tgId", "tg_id"),
    )

    telegram_username = _find_first_non_empty(
        candidates,
        (
            "telegramUsername",
            "telegram_username",
            "telegramLogin",
            "telegram_login",
            "telegramNick",
            "telegram_nick",
            "username",
            "login",
        ),
    )

    photo = _find_first_non_empty(
        candidates,
        (
            "telegramPhotoUrl",
            "telegram_photo_url",
            "telegramAvatarUrl",
            "telegram_avatar_url",
            "telegramUserpic",
            "telegram_userpic",
            "photoUrl",
            "photo_url",
            "avatarUrl",
            "avatar_url",
            "userpicUrl",
            "userpic_url",
            "avatar",
            "photo",
            "userpic",
            "imageUrl",
            "image_url",
            "profilePhotoUrl",
            "profile_photo_url",
        ),
    )

    subscription_url = _find_first_non_empty(candidates, ("subscriptionUrl", "subscription_url", "url"))

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
