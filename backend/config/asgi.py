"""
ASGI config for config project.

It exposes the ASGI callable as a module-level variable named ``application``.

For more information on this file, see
https://docs.djangoproject.com/en/6.0/howto/deployment/asgi/
"""

import os

from django.core.asgi import get_asgi_application

os.environ.setdefault('DJANGO_SETTINGS_MODULE', 'config.settings')

django_asgi_app = get_asgi_application()
from telegram_auth.chat_realtime import chat_ws_app, is_chat_ws_path


async def application(scope, receive, send):
    if scope.get("type") == "websocket" and is_chat_ws_path(str(scope.get("path", ""))):
        await chat_ws_app(scope, receive, send)
        return
    await django_asgi_app(scope, receive, send)
