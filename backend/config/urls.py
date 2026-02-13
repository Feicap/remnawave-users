from django.contrib import admin
from django.urls import include, path

urlpatterns = [
    path("", include("django_prometheus.urls")),
    path("admin/", admin.site.urls),
    path("api/", include("telegram_auth.urls")),
]
