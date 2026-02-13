import os
import hashlib
import hmac
import requests

BOT_TOKEN = os.getenv("TELEGRAM_BOT_TOKEN")
GROUP_CHAT_ID = os.getenv("TELEGRAM_GROUP_CHAT_ID")


def has_telegram_config() -> bool:
    return bool(BOT_TOKEN and GROUP_CHAT_ID)

# Верификация данных, полученных от Telegram при авторизации через Telegram Login Widget. 
# Функция принимает словарь данных, извлекает хэш и проверяет его, используя секретный ключ, 
# который является SHA-256 хэшем токена бота. Данные сортируются и объединяются в строку для проверки. 
# Если вычисленный хэш совпадает с предоставленным, функция возвращает True, иначе False.
def verify_telegram_auth(data: dict) -> bool:
    if not BOT_TOKEN:
        return False
    data = data.copy()
    auth_hash = data.pop("hash", None)
    if not auth_hash:
        return False
    data_check_string = "\n".join(f"{k}={v}" for k, v in sorted(data.items()))
    secret_key = hashlib.sha256(BOT_TOKEN.encode()).digest()
    calculated_hash = hmac.new(secret_key, data_check_string.encode(), hashlib.sha256).hexdigest()
    return hmac.compare_digest(calculated_hash, auth_hash)

# Проверка наличия пользователя в группе Telegram с помощью Telegram Bot API. 
# Отправляет запрос к методу getChatMember и проверяет статус участника. Если статус "member", "administrator" или "creator", возвращает True, иначе False.
def is_user_in_group(user_id: int) -> bool: 
    if not BOT_TOKEN or not GROUP_CHAT_ID:
        return False
    url = f"https://api.telegram.org/bot{BOT_TOKEN}/getChatMember"
    try:
        resp = requests.get(url, params={"chat_id": GROUP_CHAT_ID, "user_id": user_id}, timeout=5)
    except requests.RequestException:
        return False
    if not resp.ok:
        return False
    payload = resp.json()
    status = payload.get("result", {}).get("status")
    return status in ("member", "administrator", "creator")
