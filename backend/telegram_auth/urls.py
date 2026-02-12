from django.urls import path
from .views import telegram_login

urlpatterns = [
    path('telegram/', telegram_login, name='telegram_login'),  # POST API
]
