import os
import hashlib
import hmac
import requests

BOT_TOKEN = os.getenv("TELEGRAM_BOT_TOKEN")
GROUP_CHAT_ID = os.getenv("TELEGRAM_GROUP_CHAT_ID")

# Верификация данных, полученных от Telegram при авторизации через Telegram Login Widget. 
# Функция принимает словарь данных, извлекает хэш и проверяет его, используя секретный ключ, 
# который является SHA-256 хэшем токена бота. Данные сортируются и объединяются в строку для проверки. 
# Если вычисленный хэш совпадает с предоставленным, функция возвращает True, иначе False.
def verify_telegram_auth(data: dict) -> bool:
    data = data.copy()
    auth_hash = data.pop("hash")
    data_check_string = "\n".join(f"{k}={v}" for k, v in sorted(data.items()))
    secret_key = hashlib.sha256(BOT_TOKEN.encode()).digest()
    calculated_hash = hmac.new(secret_key, data_check_string.encode(), hashlib.sha256).hexdigest()
    return calculated_hash == auth_hash

# Проверка наличия пользователя в группе Telegram с помощью Telegram Bot API. 
# Отправляет запрос к методу getChatMember и проверяет статус участника. Если статус "member", "administrator" или "creator", возвращает True, иначе False.
def is_user_in_group(user_id: int) -> bool: 
    url = f"https://api.telegram.org/bot{BOT_TOKEN}/getChatMember"
    resp = requests.get(url, params={"chat_id": GROUP_CHAT_ID, "user_id": user_id}, timeout=5)
    if not resp.ok:
        return False
    status = resp.json()["result"]["status"]
    return status in ("member", "administrator", "creator")
