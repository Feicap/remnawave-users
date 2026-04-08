import hashlib
import hmac
import os

BOT_TOKEN = os.getenv("TELEGRAM_BOT_TOKEN")


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
