import json
from django.http import JsonResponse
from django.views.decorators.csrf import csrf_exempt
from time import time

from .services import has_telegram_config, verify_telegram_auth, is_user_in_group
from .remnawave_client import get_subscription_url_sync

# Телеграм-авторизация для доступа к подписке. 
# Верифицирует данные от Telegram, проверяет наличие пользователя в группе и возвращает информацию о пользователе и ссылку на подписку Remnawave.
@csrf_exempt
def telegram_login(request):
    if request.method != "POST":
        return JsonResponse({"error": "Invalid method"}, status=405)
        
    try:
        user = json.loads(request.body)
    except json.JSONDecodeError:
        return JsonResponse({"error": "Invalid JSON"}, status=400)

    if not has_telegram_config():
        return JsonResponse({"error": "Server Telegram config missing"}, status=500)
    
    # Верификация данных от Telegram. Проверяет корректность данных и срок их действия.
    if not verify_telegram_auth(user):
        return JsonResponse({"error": "Invalid Telegram auth"}, status=403)
    
    # если данные устарели (старше 24 часов), возвращает ошибку.
    if time() - int(user.get("auth_date", 0)) > 86400:
        return JsonResponse({"error": "Auth expired"}, status=403)
    
    # если не пользователь не состоит в группе Telegram, возвращает ошибку.
    if not is_user_in_group(user["id"]):
        return JsonResponse({"error": "User not in Telegram group"}, status=403)
    
    # Подписка Remnawave для пользователя. Получает ссылку на подписку по telegram_id. Если пользователь не найден или нет ссылки, возвращает no response.
    subscription_url = get_subscription_url_sync(user["id"]) or "no response"

    # Отправляет JSON-ответ с данными пользователя и ссылкой на подписку. Включает id, username, фото, subscription_url и фейковый токен.
    return JsonResponse({
        "id": user["id"],
        "username": user.get("username"),
        "photo": user.get("photo_url"),
        "subscription_url": subscription_url,
        "token": "FAKE_JWT"
    })
