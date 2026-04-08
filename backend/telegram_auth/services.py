import hashlib
import hmac
import json
import logging
import os
from typing import Any
from urllib.parse import urlencode
from urllib.request import urlopen

BOT_TOKEN = os.getenv("TELEGRAM_BOT_TOKEN")
TELEGRAM_API_BASE = "https://api.telegram.org"

logger = logging.getLogger(__name__)


def has_telegram_config() -> bool:
    return bool(BOT_TOKEN)


def verify_telegram_auth(data: dict) -> bool:
    if not BOT_TOKEN:
        return False

    payload = data.copy()
    auth_hash = payload.pop("hash", None)
    if not auth_hash:
        return False

    data_check_string = "\n".join(f"{key}={value}" for key, value in sorted(payload.items()))
    secret_key = hashlib.sha256(BOT_TOKEN.encode()).digest()
    calculated_hash = hmac.new(secret_key, data_check_string.encode(), hashlib.sha256).hexdigest()
    return hmac.compare_digest(calculated_hash, auth_hash)


def _telegram_api_request(method: str, params: dict[str, Any]) -> dict[str, Any] | None:
    if not BOT_TOKEN:
        return None

    query = urlencode(params)
    url = f"{TELEGRAM_API_BASE}/bot{BOT_TOKEN}/{method}"
    if query:
        url = f"{url}?{query}"

    try:
        with urlopen(url, timeout=10) as response:  # noqa: S310
            payload = json.loads(response.read().decode("utf-8"))
    except Exception as exc:
        logger.warning("Telegram API request failed for method=%s: %s", method, exc)
        return None

    if not isinstance(payload, dict) or not payload.get("ok"):
        logger.warning("Telegram API returned non-ok response for method=%s", method)
        return None

    result = payload.get("result")
    if isinstance(result, dict):
        return result
    return None


def get_telegram_avatar_file_url(telegram_id: int) -> str | None:
    if not BOT_TOKEN:
        return None

    photos_result = _telegram_api_request("getUserProfilePhotos", {"user_id": telegram_id, "limit": 1})
    if not photos_result:
        return None

    photos = photos_result.get("photos")
    if not isinstance(photos, list) or not photos:
        return None

    first_profile = photos[0]
    if not isinstance(first_profile, list) or not first_profile:
        return None

    # Берём самое крупное изображение из первой (актуальной) группы фото.
    largest_size = first_profile[-1]
    if not isinstance(largest_size, dict):
        return None

    file_id = largest_size.get("file_id")
    if not isinstance(file_id, str) or not file_id.strip():
        return None

    file_result = _telegram_api_request("getFile", {"file_id": file_id})
    if not file_result:
        return None

    file_path = file_result.get("file_path")
    if not isinstance(file_path, str) or not file_path.strip():
        return None

    return f"{TELEGRAM_API_BASE}/file/bot{BOT_TOKEN}/{file_path}"


def get_telegram_avatar_bytes(telegram_id: int) -> tuple[bytes, str] | None:
    avatar_url = get_telegram_avatar_file_url(telegram_id)
    if not avatar_url:
        return None

    try:
        with urlopen(avatar_url, timeout=10) as response:  # noqa: S310
            content = response.read()
            content_type = response.headers.get_content_type() or "image/jpeg"
    except Exception as exc:
        logger.warning("Telegram avatar download failed for telegram_id=%s: %s", telegram_id, exc)
        return None

    if not content:
        return None

    return content, content_type
