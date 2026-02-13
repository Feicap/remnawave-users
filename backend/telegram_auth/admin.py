from django.contrib import admin

from .models import PaymentProof


@admin.register(PaymentProof)
class PaymentProofAdmin(admin.ModelAdmin):
    list_display = ("id", "user_id", "username", "status", "created_at", "reviewed_at", "reviewed_by")
    list_filter = ("status", "created_at")
    search_fields = ("user_id", "username")
