from django.contrib import admin

from .models import AuthIdentity, ChatMessage, ChatModerationAction, ChatReadMarker, ChatUserProfile, PaymentProof


@admin.register(PaymentProof)
class PaymentProofAdmin(admin.ModelAdmin):
    list_display = ("id", "user_id", "username", "status", "created_at", "reviewed_at", "reviewed_by")
    list_filter = ("status", "created_at")
    search_fields = ("user_id", "username")


@admin.register(ChatMessage)
class ChatMessageAdmin(admin.ModelAdmin):
    list_display = ("id", "scope", "sender_id", "sender_username", "recipient_id", "created_at")
    list_filter = ("scope", "created_at")
    search_fields = ("sender_id", "sender_username", "recipient_id", "recipient_username", "body")


@admin.register(ChatReadMarker)
class ChatReadMarkerAdmin(admin.ModelAdmin):
    list_display = ("id", "user_id", "scope", "peer_id", "last_read_at")
    list_filter = ("scope",)
    search_fields = ("user_id", "peer_id")


@admin.register(ChatUserProfile)
class ChatUserProfileAdmin(admin.ModelAdmin):
    list_display = ("user_id", "display_name", "username", "email", "telegram_username", "auth_provider", "updated_at")
    list_filter = ("auth_provider",)
    search_fields = ("user_id", "display_name", "username", "email", "telegram_username")


@admin.register(ChatModerationAction)
class ChatModerationActionAdmin(admin.ModelAdmin):
    list_display = ("id", "action", "message_id", "acted_by_user_id", "is_admin_action", "created_at")
    list_filter = ("action", "is_admin_action", "created_at")
    search_fields = ("message_id", "acted_by_user_id", "acted_by_username")


@admin.register(AuthIdentity)
class AuthIdentityAdmin(admin.ModelAdmin):
    list_display = ("id", "user_id", "provider", "provider_user_id", "updated_at")
    list_filter = ("provider",)
    search_fields = ("user_id", "provider_user_id")
