from django.db import models
from django.db.models import Q
from django.contrib.auth.models import User
from django.utils import timezone


def payment_proof_upload_path(instance: "PaymentProof", filename: str) -> str:
    return f"payment_proofs/{instance.user_id}/{filename}"


def chat_avatar_upload_path(instance: "ChatUserProfile", filename: str) -> str:
    return f"chat_avatars/{instance.user_id}/{filename}"


class PaymentProof(models.Model):
    STATUS_PENDING = "pending"
    STATUS_APPROVED = "approved"
    STATUS_REJECTED = "rejected"
    STATUS_CHOICES = (
        (STATUS_PENDING, "Pending"),
        (STATUS_APPROVED, "Approved"),
        (STATUS_REJECTED, "Rejected"),
    )

    user_id = models.BigIntegerField(db_index=True)
    username = models.CharField(max_length=255, blank=True, default="")
    file = models.FileField(upload_to=payment_proof_upload_path)
    status = models.CharField(max_length=16, choices=STATUS_CHOICES, default=STATUS_PENDING, db_index=True)
    created_at = models.DateTimeField(auto_now_add=True, db_index=True)
    reviewed_at = models.DateTimeField(null=True, blank=True)
    reviewed_by = models.BigIntegerField(null=True, blank=True)
    reviewed_by_username = models.CharField(max_length=255, blank=True, default="")

    def __str__(self) -> str:
        return f"{self.user_id} - {self.status} - {self.created_at.isoformat()}"


class ChatUserProfile(models.Model):
    user_id = models.BigIntegerField(unique=True, db_index=True)
    telegram_id = models.BigIntegerField(null=True, blank=True, unique=True, db_index=True)
    display_name = models.CharField(max_length=255, blank=True, default="")
    username = models.CharField(max_length=255, blank=True, default="")
    email = models.CharField(max_length=255, blank=True, default="")
    telegram_username = models.CharField(max_length=255, blank=True, default="")
    photo = models.CharField(max_length=2048, blank=True, default="")
    avatar_file = models.FileField(upload_to=chat_avatar_upload_path, null=True, blank=True)
    avatar_scale = models.FloatField(default=1.0)
    avatar_position_x = models.PositiveSmallIntegerField(default=50)
    avatar_position_y = models.PositiveSmallIntegerField(default=50)
    auth_provider = models.CharField(max_length=32, blank=True, default="")
    created_at = models.DateTimeField(auto_now_add=True, db_index=True)
    updated_at = models.DateTimeField(auto_now=True, db_index=True)

    def __str__(self) -> str:
        display = self.display_name or self.telegram_username or self.username or self.email or str(self.user_id)
        return f"{self.user_id} - {display}"


class AuthIdentity(models.Model):
    PROVIDER_EMAIL = "email"
    PROVIDER_TELEGRAM = "telegram"
    PROVIDER_CHOICES = (
        (PROVIDER_EMAIL, "Email"),
        (PROVIDER_TELEGRAM, "Telegram"),
    )

    user = models.ForeignKey(User, on_delete=models.CASCADE, related_name="auth_identities")
    provider = models.CharField(max_length=16, choices=PROVIDER_CHOICES, db_index=True)
    provider_user_id = models.CharField(max_length=255, db_index=True)
    created_at = models.DateTimeField(auto_now_add=True, db_index=True)
    updated_at = models.DateTimeField(auto_now=True, db_index=True)

    class Meta:
        constraints = [
            models.UniqueConstraint(fields=["provider", "provider_user_id"], name="uniq_auth_identity_provider_key"),
            models.UniqueConstraint(fields=["user", "provider"], name="uniq_auth_identity_user_provider"),
        ]
        indexes = [
            models.Index(fields=["user", "provider"]),
        ]

    def __str__(self) -> str:
        return f"{self.provider}:{self.provider_user_id} -> {self.user_id}"


class ChatMessage(models.Model):
    SCOPE_GLOBAL = "global"
    SCOPE_PRIVATE = "private"
    SCOPE_CHOICES = (
        (SCOPE_GLOBAL, "Global"),
        (SCOPE_PRIVATE, "Private"),
    )

    scope = models.CharField(max_length=16, choices=SCOPE_CHOICES, db_index=True)
    sender_id = models.BigIntegerField(db_index=True)
    sender_username = models.CharField(max_length=255, blank=True, default="")
    recipient_id = models.BigIntegerField(null=True, blank=True, db_index=True)
    recipient_username = models.CharField(max_length=255, blank=True, default="")
    client_message_id = models.CharField(max_length=64, blank=True, default="", db_index=True)
    body = models.TextField()
    is_deleted = models.BooleanField(default=False, db_index=True)
    deleted_at = models.DateTimeField(null=True, blank=True)
    deleted_by_user_id = models.BigIntegerField(null=True, blank=True)
    deleted_by_admin = models.BooleanField(default=False)
    edited_at = models.DateTimeField(null=True, blank=True, db_index=True)
    created_at = models.DateTimeField(auto_now_add=True, db_index=True)

    class Meta:
        constraints = [
            models.UniqueConstraint(
                fields=["sender_id", "client_message_id"],
                condition=~Q(client_message_id=""),
                name="unique_sender_client_message",
            ),
        ]
        indexes = [
            models.Index(fields=["scope", "created_at"]),
            models.Index(fields=["recipient_id", "created_at"]),
            models.Index(fields=["sender_id", "created_at"]),
        ]

    def __str__(self) -> str:
        if self.scope == self.SCOPE_GLOBAL:
            return f"global:{self.sender_id}:{self.created_at.isoformat()}"
        return f"private:{self.sender_id}->{self.recipient_id}:{self.created_at.isoformat()}"


class ChatReadMarker(models.Model):
    SCOPE_GLOBAL = ChatMessage.SCOPE_GLOBAL
    SCOPE_PRIVATE = ChatMessage.SCOPE_PRIVATE
    SCOPE_CHOICES = ChatMessage.SCOPE_CHOICES
    GLOBAL_PEER_ID = 0

    user_id = models.BigIntegerField(db_index=True)
    scope = models.CharField(max_length=16, choices=SCOPE_CHOICES, db_index=True)
    peer_id = models.BigIntegerField(default=GLOBAL_PEER_ID, db_index=True)
    last_read_at = models.DateTimeField(default=timezone.now)

    class Meta:
        constraints = [
            models.UniqueConstraint(fields=["user_id", "scope", "peer_id"], name="unique_chat_read_marker"),
        ]
        indexes = [
            models.Index(fields=["user_id", "scope", "peer_id"]),
        ]

    def __str__(self) -> str:
        return f"{self.user_id}:{self.scope}:{self.peer_id}:{self.last_read_at.isoformat()}"


class ChatModerationAction(models.Model):
    ACTION_EDIT = "edit"
    ACTION_DELETE = "delete"
    ACTION_CHOICES = (
        (ACTION_EDIT, "Edit"),
        (ACTION_DELETE, "Delete"),
    )

    message = models.ForeignKey(ChatMessage, on_delete=models.CASCADE, related_name="moderation_actions")
    action = models.CharField(max_length=16, choices=ACTION_CHOICES, db_index=True)
    acted_by_user_id = models.BigIntegerField(db_index=True)
    acted_by_username = models.CharField(max_length=255, blank=True, default="")
    is_admin_action = models.BooleanField(default=False, db_index=True)
    previous_body = models.TextField(blank=True, default="")
    next_body = models.TextField(blank=True, default="")
    created_at = models.DateTimeField(auto_now_add=True, db_index=True)

    def __str__(self) -> str:
        return f"{self.action}:{self.message_id}:{self.acted_by_user_id}:{self.created_at.isoformat()}"
