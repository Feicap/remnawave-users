import json
import mimetypes
import os
import re
from datetime import datetime, timedelta, timezone
from pathlib import Path
from time import time
from urllib.parse import unquote
from django.contrib.auth.models import User
from django.core.exceptions import ValidationError
from django.core.validators import validate_email
from django.db import IntegrityError, transaction
from django.db.models import Count, Max, Q
from django.http import FileResponse, HttpRequest, HttpResponse, JsonResponse
from django.http.multipartparser import MultiPartParser, MultiPartParserError
from django.utils.dateparse import parse_datetime
from django.utils import timezone as dj_timezone
from django.views.decorators.csrf import csrf_exempt

from .chat_realtime import publish_chat_event
from .models import AuthIdentity, ChatMessage, ChatModerationAction, ChatReadMarker, ChatUserProfile, PaymentProof, UserNotification
from .remnawave_client import get_remnawave_user_sync
from .services import get_telegram_avatar_bytes, has_telegram_config, verify_telegram_auth

ALLOWED_IMAGE_EXTENSIONS = {".jpg", ".jpeg", ".png", ".webp", ".bmp", ".heic", ".svg"}
MAX_FILE_SIZE_BYTES = 10 * 1024 * 1024
ONLINE_WINDOW_MINUTES = max(1, int(os.getenv("ADMIN_ONLINE_WINDOW_MINUTES", "15")))
PROFILE_ONLINE_WINDOW_SECONDS = 120
DEFAULT_ADMIN_USERS_PAGE_SIZE = 200
DEFAULT_CHAT_PAGE_SIZE = 100
MAX_CHAT_PAGE_SIZE = 200
MAX_CHAT_MESSAGE_LENGTH = 2000
CHAT_RATE_LIMIT_WINDOW_SECONDS = max(1, int(os.getenv("CHAT_RATE_LIMIT_WINDOW_SECONDS", "10")))
CHAT_RATE_LIMIT_MAX_MESSAGES = max(1, int(os.getenv("CHAT_RATE_LIMIT_MAX_MESSAGES", "8")))
MAX_AVATAR_FILE_SIZE_BYTES = 5 * 1024 * 1024
MAX_CHAT_DISPLAY_NAME_LENGTH = 64
CHAT_DISPLAY_NAME_PATTERN = re.compile(r"^[\w .\-а-яА-ЯёЁ]{2,64}$")
MIN_AVATAR_SCALE = 1.0
MAX_AVATAR_SCALE = 3.0
MIN_AVATAR_POSITION = 0
MAX_AVATAR_POSITION = 100


def _normalize_email(value: str) -> str:
    return value.strip().lower()


def _telegram_identity_key(telegram_id: int) -> str:
    return str(telegram_id)


def _find_identity(*, provider: str, provider_user_id: str) -> AuthIdentity | None:
    return AuthIdentity.objects.select_related("user").filter(provider=provider, provider_user_id=provider_user_id).first()


def _find_user_by_identity(*, provider: str, provider_user_id: str) -> User | None:
    identity = _find_identity(provider=provider, provider_user_id=provider_user_id)
    return identity.user if identity is not None else None


def _ensure_identity(
    *,
    user: User,
    provider: str,
    provider_user_id: str | None,
    strict: bool = False,
) -> tuple[bool, JsonResponse | None]:
    normalized_key = (provider_user_id or "").strip()
    if not normalized_key:
        return True, None

    existing = _find_identity(provider=provider, provider_user_id=normalized_key)
    if existing is not None and existing.user_id != user.id:
        if strict:
            return False, JsonResponse({"error": f"{provider.capitalize()} identity already linked to another account"}, status=409)
        return False, None

    current_provider_identity = AuthIdentity.objects.filter(user=user, provider=provider).first()
    if current_provider_identity is not None:
        if current_provider_identity.provider_user_id == normalized_key:
            return True, None
        conflict = _find_identity(provider=provider, provider_user_id=normalized_key)
        if conflict is not None and conflict.id != current_provider_identity.id:
            if strict:
                return False, JsonResponse({"error": f"{provider.capitalize()} identity already linked to another account"}, status=409)
            return False, None
        current_provider_identity.provider_user_id = normalized_key
        current_provider_identity.save(update_fields=["provider_user_id", "updated_at"])
        return True, None

    if existing is None:
        AuthIdentity.objects.create(user=user, provider=provider, provider_user_id=normalized_key)
    return True, None


def _get_auth_bindings_for_user(user_id: int) -> tuple[bool, bool]:
    providers = set(AuthIdentity.objects.filter(user_id=user_id).values_list("provider", flat=True))
    return AuthIdentity.PROVIDER_EMAIL in providers, AuthIdentity.PROVIDER_TELEGRAM in providers


def _validate_email_credentials(payload: dict) -> tuple[str | None, str | None, JsonResponse | None]:
    email = _normalize_email(str(payload.get("email", "")))
    password = str(payload.get("password", ""))

    try:
        validate_email(email)
    except ValidationError:
        return None, None, JsonResponse({"error": "Invalid email"}, status=400)

    if not password:
        return None, None, JsonResponse({"error": "Password is required"}, status=400)

    return email, password, None


def _find_user_by_email(email: str) -> User | None:
    normalized_email = _normalize_email(email)
    by_identity = _find_user_by_identity(provider=AuthIdentity.PROVIDER_EMAIL, provider_user_id=normalized_email)
    if by_identity is not None:
        return by_identity
    return User.objects.filter(Q(email__iexact=normalized_email) | Q(username__iexact=normalized_email)).first()


def _find_user_by_id_or_email(*, user_id: int | None = None, email: str | None = None) -> User | None:
    if user_id is not None:
        user_by_id = User.objects.filter(id=user_id).first()
        if user_by_id is not None:
            return user_by_id
    if email:
        return _find_user_by_email(email)
    return None


def _find_profile_by_telegram_id(telegram_id: int | None) -> ChatUserProfile | None:
    if telegram_id is None:
        return None
    return ChatUserProfile.objects.filter(telegram_id=telegram_id).first()


def _find_user_by_telegram_id(telegram_id: int | None) -> User | None:
    if telegram_id is None:
        return None
    by_identity = _find_user_by_identity(
        provider=AuthIdentity.PROVIDER_TELEGRAM,
        provider_user_id=_telegram_identity_key(telegram_id),
    )
    if by_identity is not None:
        return by_identity
    profile = _find_profile_by_telegram_id(telegram_id)
    if profile is None:
        return None
    return User.objects.filter(id=profile.user_id).first()


def _parse_optional_any_int(value: object | None) -> int | None:
    if value is None:
        return None
    return _parse_optional_int(str(value))


def _build_unique_telegram_login(telegram_id: int) -> str:
    base = f"tg_{telegram_id}"
    candidate = base
    suffix = 1
    while User.objects.filter(username__iexact=candidate).exists():
        suffix += 1
        candidate = f"{base}_{suffix}"
    return candidate


def _ensure_auth_user(
    *,
    user_id_hint: int | None,
    email: str | None,
    telegram_id: int | None,
) -> User | None:
    normalized_email = _normalize_email(email) if email else None
    user_by_email_identity = (
        _find_user_by_identity(provider=AuthIdentity.PROVIDER_EMAIL, provider_user_id=normalized_email)
        if normalized_email
        else None
    )
    user_by_telegram_identity = (
        _find_user_by_identity(
            provider=AuthIdentity.PROVIDER_TELEGRAM,
            provider_user_id=_telegram_identity_key(telegram_id),
        )
        if telegram_id is not None
        else None
    )
    user_by_email = _find_user_by_email(normalized_email) if normalized_email else None
    user_by_telegram = _find_user_by_telegram_id(telegram_id)
    user_by_hint = User.objects.filter(id=user_id_hint).first() if user_id_hint is not None else None
    legacy_profile = ChatUserProfile.objects.filter(user_id=user_id_hint).first() if user_id_hint is not None else None

    if (
        user_by_email_identity is not None
        and user_by_telegram_identity is not None
        and user_by_email_identity.id != user_by_telegram_identity.id
    ):
        user = user_by_email_identity if normalized_email else user_by_telegram_identity
    else:
        user = user_by_email_identity or user_by_telegram_identity or user_by_email or user_by_telegram or user_by_hint
    if user is None:
        if normalized_email:
            login = normalized_email
        elif telegram_id is not None:
            login = _build_unique_telegram_login(telegram_id)
        else:
            return None

        should_preserve_legacy_id = (
            user_id_hint is not None
            and legacy_profile is not None
            and User.objects.filter(id=user_id_hint).first() is None
        )
        user = User(id=user_id_hint, username=login, email=normalized_email or "") if should_preserve_legacy_id else User(
            username=login,
            email=normalized_email or "",
        )
        user.set_unusable_password()
        if should_preserve_legacy_id:
            try:
                user.save(force_insert=True)
            except IntegrityError:
                user.id = None
                user.save()
        else:
            user.save()

    update_fields: list[str] = []
    if normalized_email and user.email.lower() != normalized_email:
        user.email = normalized_email
        update_fields.append("email")

    if normalized_email and (not user.username or user.username.startswith("tg_")):
        has_conflict = (
            User.objects.filter(Q(username__iexact=normalized_email) | Q(email__iexact=normalized_email))
            .exclude(id=user.id)
            .exists()
        )
        if not has_conflict and user.username != normalized_email:
            user.username = normalized_email
            update_fields.append("username")

    if update_fields:
        user.save(update_fields=list(dict.fromkeys(update_fields)))

    if normalized_email:
        _ensure_identity(
            user=user,
            provider=AuthIdentity.PROVIDER_EMAIL,
            provider_user_id=normalized_email,
            strict=False,
        )
    if telegram_id is not None:
        _ensure_identity(
            user=user,
            provider=AuthIdentity.PROVIDER_TELEGRAM,
            provider_user_id=_telegram_identity_key(telegram_id),
            strict=False,
        )
    return user


def _parse_optional_int(value: str) -> int | None:
    cleaned = value.strip()
    if not cleaned:
        return None
    if cleaned.startswith("-"):
        cleaned = cleaned[1:]
    if not cleaned.isdigit():
        return None
    return int(value.strip())


def _parse_optional_float(value: object | None) -> float | None:
    if value is None:
        return None
    try:
        parsed = float(str(value).strip())
    except (TypeError, ValueError):
        return None
    if parsed != parsed:  # NaN
        return None
    return parsed


def _clamp_avatar_scale(value: float) -> float:
    return max(MIN_AVATAR_SCALE, min(MAX_AVATAR_SCALE, value))


def _clamp_avatar_position(value: int) -> int:
    return max(MIN_AVATAR_POSITION, min(MAX_AVATAR_POSITION, value))


def _normalize_optional_text(value: object | None) -> str | None:
    if value is None:
        return None
    normalized = str(value).strip()
    return normalized or None


def _parse_optional_bool(value: object | None) -> bool | None:
    if value is None:
        return None
    if isinstance(value, bool):
        return value
    normalized = str(value).strip().lower()
    if normalized in {"1", "true", "yes", "on"}:
        return True
    if normalized in {"0", "false", "no", "off"}:
        return False
    return None


def _build_auth_payload(
    *,
    user_id: int,
    username: str = "",
    photo: str = "",
    email: str | None = None,
    telegram_id: int | None = None,
    telegram_username: str | None = None,
    subscription_url: str | None = None,
    auth_provider: str,
    remnawave_user: dict | None = None,
) -> dict:
    remnawave_user = remnawave_user or {}

    resolved_email = _normalize_optional_text(remnawave_user.get("email")) or _normalize_optional_text(email)
    resolved_telegram_id = remnawave_user.get("telegram_id") or telegram_id
    resolved_telegram_username = _normalize_optional_text(remnawave_user.get("telegram_username")) or _normalize_optional_text(
        telegram_username
    )
    resolved_photo = _normalize_optional_text(remnawave_user.get("photo")) or _normalize_optional_text(photo)
    resolved_subscription_url = _normalize_optional_text(remnawave_user.get("subscription_url")) or _normalize_optional_text(
        subscription_url
    )

    has_email_auth, has_telegram_auth = _get_auth_bindings_for_user(user_id)
    if resolved_email:
        has_email_auth = True
    if resolved_telegram_id is not None:
        has_telegram_auth = True

    display_username = username or resolved_telegram_username or resolved_email or ""

    payload = {
        "id": user_id,
        "username": display_username,
        "photo": resolved_photo or "",
        "token": "FAKE_JWT",
        "auth_provider": auth_provider,
        "has_email_auth": has_email_auth,
        "has_telegram_auth": has_telegram_auth,
        "can_link_email": not has_email_auth,
        "can_link_telegram": not has_telegram_auth,
    }
    if resolved_email:
        payload["email"] = resolved_email
    if resolved_telegram_id is not None:
        payload["telegram_id"] = resolved_telegram_id
    if resolved_telegram_username:
        payload["telegram_username"] = resolved_telegram_username
    if resolved_subscription_url:
        payload["subscription_url"] = resolved_subscription_url
    return payload


def _build_auth_response(**kwargs) -> JsonResponse:
    payload = _build_auth_payload(**kwargs)
    return JsonResponse(payload)


def _touch_user_last_login(*, user_id: int | None = None, email: str | None = None) -> None:
    user = _find_user_by_id_or_email(user_id=user_id, email=email)
    if user is None:
        return
    user.last_login = dj_timezone.now()
    user.save(update_fields=["last_login"])


def _attach_presence_payload(payload: dict, *, user_id: int) -> dict:
    user = User.objects.filter(id=user_id).only("last_login").first()
    last_seen_at = user.last_login if user is not None else None
    online_after = dj_timezone.now() - timedelta(seconds=PROFILE_ONLINE_WINDOW_SECONDS)
    payload["is_online"] = _is_online(last_seen_at, online_after)
    payload["last_seen_at"] = last_seen_at.isoformat() if last_seen_at else None
    payload["online_window_seconds"] = PROFILE_ONLINE_WINDOW_SECONDS
    return payload


def _merge_remnawave_users(primary: dict | None, secondary: dict | None) -> dict | None:
    if primary is None:
        return secondary
    if secondary is None:
        return primary

    merged = dict(primary)
    for key in ("email", "telegram_id", "telegram_username", "photo", "subscription_url"):
        primary_value = merged.get(key)
        if isinstance(primary_value, str):
            primary_value = primary_value.strip()

        secondary_value = secondary.get(key)
        if isinstance(secondary_value, str):
            secondary_value = secondary_value.strip()

        if not primary_value and secondary_value:
            merged[key] = secondary.get(key)

    if merged.get("raw") is None and secondary.get("raw") is not None:
        merged["raw"] = secondary["raw"]

    return merged


def _resolve_remnawave_user(*, email: str | None = None, telegram_id: int | None = None) -> dict | None:
    if not email and telegram_id is None:
        return None

    if email:
        by_email_user = get_remnawave_user_sync(email=email)
        fallback_telegram_id = by_email_user.get("telegram_id") if by_email_user else telegram_id
        by_email_photo = _normalize_optional_text(by_email_user.get("photo")) if by_email_user else None

        # Делаем второй запрос только если email-поиск не дал фото, но есть Telegram ID.
        if by_email_user and by_email_photo:
            return by_email_user

        if fallback_telegram_id is None:
            return by_email_user

        by_telegram_user = get_remnawave_user_sync(telegram_id=fallback_telegram_id)
        return _merge_remnawave_users(by_email_user, by_telegram_user)

    return get_remnawave_user_sync(telegram_id=telegram_id)


def _parse_admin_ids() -> set[int]:
    raw = os.getenv("VITE_ADMIN") or os.getenv("ADMIN") or ""
    normalized = raw.strip().strip("[]")
    result: set[int] = set()
    if not normalized:
        return result
    for value in normalized.split(","):
        cleaned = value.strip()
        if cleaned.isdigit():
            result.add(int(cleaned))
    return result


def _decode_header_text(value: str | None) -> str:
    normalized = (value or "").strip()
    if not normalized.startswith("utf8:"):
        return normalized
    try:
        return unquote(normalized[5:]).strip()
    except Exception:
        return ""


def _extract_auth_user(request: HttpRequest) -> tuple[int | None, str]:
    header_user_id = request.headers.get("X-Telegram-User-Id", "").strip()
    header_username = _decode_header_text(request.headers.get("X-Telegram-Username"))
    if not header_user_id.isdigit():
        return None, header_username
    return int(header_user_id), header_username


def _extract_auth_identity(request: HttpRequest) -> tuple[int | None, str | None, int | None, str, str, str, str]:
    user_id = _parse_optional_int(request.headers.get("X-Auth-User-Id", "")) or _parse_optional_int(
        request.headers.get("X-Telegram-User-Id", "")
    )
    email = _normalize_email(_decode_header_text(request.headers.get("X-Auth-Email"))) or None
    telegram_id = _parse_optional_int(request.headers.get("X-Auth-Telegram-Id", ""))
    username = _decode_header_text(request.headers.get("X-Auth-Username")) or _decode_header_text(
        request.headers.get("X-Telegram-Username")
    )
    telegram_username = _decode_header_text(request.headers.get("X-Auth-Telegram-Username"))
    photo = _decode_header_text(request.headers.get("X-Auth-Photo"))
    auth_provider = _decode_header_text(request.headers.get("X-Auth-Provider"))
    return user_id, email, telegram_id, username, telegram_username, photo, auth_provider


def _is_admin(user_id: int) -> bool:
    return user_id in _parse_admin_ids()


def _is_admin_identity(user_id: int | None, telegram_id: int | None = None) -> bool:
    if user_id is not None and _is_admin(user_id):
        return True
    return telegram_id is not None and _is_admin(telegram_id)


def _resolve_admin_user_ids() -> set[int]:
    admin_ids = _parse_admin_ids()
    if not admin_ids:
        return set()

    result = set(User.objects.filter(id__in=admin_ids).values_list("id", flat=True))
    result.update(
        ChatUserProfile.objects.filter(telegram_id__in=admin_ids).values_list("user_id", flat=True)
    )
    return result


def _serialize_notification(notification: UserNotification) -> dict:
    return {
        "id": notification.id,
        "kind": notification.kind,
        "title": notification.title,
        "body": notification.body,
        "link_url": notification.link_url,
        "is_read": notification.is_read,
        "created_at": notification.created_at.isoformat(),
        "read_at": notification.read_at.isoformat() if notification.read_at else None,
    }


def _create_user_notification(
    *,
    user_id: int,
    kind: str,
    title: str,
    body: str = "",
    link_url: str = "",
) -> UserNotification:
    notification = UserNotification.objects.create(
        user_id=user_id,
        kind=kind,
        title=title[:255],
        body=body,
        link_url=link_url[:2048],
    )
    publish_chat_event(
        {
            "event": "notification_created",
            "scope": "notification",
            "user_id": user_id,
            "notification_id": notification.id,
        }
    )
    return notification


def _notify_admins(*, kind: str, title: str, body: str = "", link_url: str = "") -> None:
    for admin_user_id in _resolve_admin_user_ids():
        _create_user_notification(user_id=admin_user_id, kind=kind, title=title, body=body, link_url=link_url)


def _serialize_proof(proof: PaymentProof) -> dict:
    return {
        "id": proof.id,
        "user_id": proof.user_id,
        "username": proof.username,
        "status": proof.status,
        "created_at": proof.created_at.isoformat(),
        "reviewed_at": proof.reviewed_at.isoformat() if proof.reviewed_at else None,
        "reviewed_by": proof.reviewed_by,
        "reviewed_by_username": proof.reviewed_by_username,
    }


def _is_online(last_login: datetime | None, online_after: datetime) -> bool:
    return last_login is not None and last_login >= online_after


def _chat_profile_avatar_url(profile: ChatUserProfile | None) -> str:
    if profile is None:
        return ""
    if profile.avatar_file and profile.avatar_file.name:
        return f"/api/profile/avatar/{profile.user_id}/"
    return profile.photo or ""


def _is_local_profile_avatar_url(value: str | None) -> bool:
    normalized = (value or "").strip()
    return normalized.startswith("/api/profile/avatar/") or "/api/profile/avatar/" in normalized


def _serialize_avatar_presentation(profile: ChatUserProfile | None) -> dict[str, float | int]:
    if profile is None:
        return {
            "avatar_scale": 1.0,
            "avatar_position_x": 50,
            "avatar_position_y": 50,
        }
    return {
        "avatar_scale": float(profile.avatar_scale),
        "avatar_position_x": int(profile.avatar_position_x),
        "avatar_position_y": int(profile.avatar_position_y),
    }


def _serialize_admin_user(user: User, *, online_after: datetime) -> dict:
    normalized_email = _normalize_email(user.email or user.username or "")
    remnawave_user = _resolve_remnawave_user(email=normalized_email) if normalized_email else None
    subscription_url = _normalize_optional_text((remnawave_user or {}).get("subscription_url"))
    has_remnawave_access = bool(subscription_url)

    chat_profile = ChatUserProfile.objects.filter(user_id=user.id).first()
    avatar_url = ""
    display_name = ""
    chat_username = ""
    chat_email = ""
    chat_telegram_username = ""
    chat_telegram_id: int | None = None
    chat_auth_provider = ""
    chat_photo = ""
    if chat_profile is not None:
        avatar_url = _chat_profile_avatar_url(chat_profile)
        display_name = chat_profile.display_name
        chat_username = chat_profile.username
        chat_email = chat_profile.email
        chat_telegram_username = chat_profile.telegram_username
        chat_telegram_id = chat_profile.telegram_id
        chat_auth_provider = chat_profile.auth_provider
        chat_photo = chat_profile.photo
    avatar_presentation = _serialize_avatar_presentation(chat_profile)

    return {
        "id": user.id,
        "login": user.username,
        "email": user.email,
        "date_joined": user.date_joined.isoformat() if user.date_joined else None,
        "last_login": user.last_login.isoformat() if user.last_login else None,
        "is_online": _is_online(user.last_login, online_after),
        "has_password": user.has_usable_password(),
        "has_remnawave_access": has_remnawave_access,
        "subscription_url": subscription_url or "",
        "display_name": display_name,
        "avatar_url": avatar_url,
        "chat_username": chat_username,
        "chat_email": chat_email,
        "chat_telegram_username": chat_telegram_username,
        "chat_telegram_id": chat_telegram_id,
        "chat_auth_provider": chat_auth_provider,
        "chat_photo": chat_photo,
        "avatar_scale": avatar_presentation["avatar_scale"],
        "avatar_position_x": avatar_presentation["avatar_position_x"],
        "avatar_position_y": avatar_presentation["avatar_position_y"],
    }


def _serialize_admin_user_detail(user: User, *, online_after: datetime) -> dict:
    payload = _serialize_admin_user(user, online_after=online_after)
    proof_rows = PaymentProof.objects.filter(user_id=user.id)
    payment_counts = {
        "total": proof_rows.count(),
        "pending": proof_rows.filter(status=PaymentProof.STATUS_PENDING).count(),
        "approved": proof_rows.filter(status=PaymentProof.STATUS_APPROVED).count(),
        "rejected": proof_rows.filter(status=PaymentProof.STATUS_REJECTED).count(),
    }
    recent_proofs = list(proof_rows.order_by("-created_at")[:5])
    chat_rows = ChatMessage.objects.filter(Q(sender_id=user.id) | Q(recipient_id=user.id))
    latest_chat = chat_rows.order_by("-created_at").first()
    identities = list(
        AuthIdentity.objects.filter(user_id=user.id)
        .order_by("provider")
        .values("provider", "provider_user_id", "created_at", "updated_at")
    )
    payload["details"] = {
        "payment_counts": payment_counts,
        "recent_payment_proofs": [
            {
                **_serialize_proof(proof),
                "file_url": f"/api/payment-proofs/{proof.id}/file/",
            }
            for proof in recent_proofs
        ],
        "chat_counts": {
            "total": chat_rows.count(),
            "sent": chat_rows.filter(sender_id=user.id).count(),
            "received": chat_rows.filter(recipient_id=user.id).count(),
            "global": chat_rows.filter(scope=ChatMessage.SCOPE_GLOBAL).count(),
            "private": chat_rows.filter(scope=ChatMessage.SCOPE_PRIVATE).count(),
            "deleted": chat_rows.filter(is_deleted=True).count(),
            "latest_message_at": latest_chat.created_at.isoformat() if latest_chat else None,
        },
        "moderation_actions_count": ChatModerationAction.objects.filter(acted_by_user_id=user.id).count(),
        "auth_identities": [
            {
                "provider": row["provider"],
                "provider_user_id": row["provider_user_id"],
                "created_at": row["created_at"].isoformat() if row["created_at"] else None,
                "updated_at": row["updated_at"].isoformat() if row["updated_at"] else None,
            }
            for row in identities
        ],
    }
    return payload


def _resolve_chat_display_name(
    *,
    user_id: int,
    display_name: str = "",
    username: str = "",
    email: str | None = None,
    telegram_username: str = "",
) -> str:
    candidates = (
        display_name.strip() if isinstance(display_name, str) else "",
        telegram_username.strip(),
        username.strip(),
        (email or "").strip(),
    )
    for value in candidates:
        if value:
            return value[:255]
    return f"user-{user_id}"


def _upsert_chat_profile(
    *,
    user_id: int | None,
    username: str = "",
    email: str | None = None,
    telegram_id: int | None = None,
    telegram_username: str = "",
    photo: str | None = None,
    auth_provider: str = "",
    display_name: str | None = None,
    avatar_scale: float | None = None,
    avatar_position_x: int | None = None,
    avatar_position_y: int | None = None,
) -> ChatUserProfile:
    if user_id is None:
        raise ValueError("user_id is required")

    profile, _ = ChatUserProfile.objects.get_or_create(user_id=user_id)
    update_fields: list[str] = []

    def _set_if_changed(field: str, value: object) -> None:
        nonlocal update_fields
        if getattr(profile, field) != value:
            setattr(profile, field, value)
            update_fields.append(field)

    _set_if_changed("username", username[:255])
    _set_if_changed("email", _normalize_email(email)[:255] if email else "")
    if telegram_id is not None and profile.telegram_id != telegram_id:
        ChatUserProfile.objects.filter(telegram_id=telegram_id).exclude(user_id=user_id).update(telegram_id=None)
        _set_if_changed("telegram_id", telegram_id)
    _set_if_changed("telegram_username", telegram_username[:255])
    _set_if_changed("auth_provider", auth_provider[:32])
    if photo is not None and not _is_local_profile_avatar_url(photo):
        _set_if_changed("photo", photo[:2048])
    if display_name is not None:
        _set_if_changed("display_name", display_name[:255])
    if avatar_scale is not None:
        _set_if_changed("avatar_scale", _clamp_avatar_scale(float(avatar_scale)))
    if avatar_position_x is not None:
        _set_if_changed("avatar_position_x", _clamp_avatar_position(int(avatar_position_x)))
    if avatar_position_y is not None:
        _set_if_changed("avatar_position_y", _clamp_avatar_position(int(avatar_position_y)))

    if update_fields:
        profile.save(update_fields=update_fields + ["updated_at"])
    return profile


def _parse_chat_limit(request: HttpRequest) -> int:
    raw_limit = request.GET.get("limit", str(DEFAULT_CHAT_PAGE_SIZE)).strip()
    if not raw_limit.isdigit():
        return DEFAULT_CHAT_PAGE_SIZE
    return max(1, min(MAX_CHAT_PAGE_SIZE, int(raw_limit)))


def _parse_optional_chat_before_id(request: HttpRequest) -> int | None:
    raw_value = request.GET.get("before_id", "").strip()
    if not raw_value:
        return None
    if not raw_value.isdigit():
        return None
    parsed = int(raw_value)
    return parsed if parsed > 0 else None


def _parse_optional_datetime(value: str | None) -> datetime | None:
    if not value:
        return None
    parsed = parse_datetime(value.strip())
    if parsed is None:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed


def _chat_rate_limit_exceeded(sender_id: int) -> bool:
    window_start = dj_timezone.now() - timedelta(seconds=CHAT_RATE_LIMIT_WINDOW_SECONDS)
    recent_count = ChatMessage.objects.filter(sender_id=sender_id, created_at__gte=window_start).count()
    return recent_count >= CHAT_RATE_LIMIT_MAX_MESSAGES


def _redacted_deleted_body() -> str:
    return "Сообщение удалено"


def _serialize_chat_user(profile: ChatUserProfile | dict, *, unread_count: int, last_message_at: datetime | None) -> dict:
    if isinstance(profile, ChatUserProfile):
        user_id = profile.user_id
        username = profile.display_name or profile.username
        email = profile.email
        telegram_username = profile.telegram_username
        photo = _chat_profile_avatar_url(profile)
        auth_provider = profile.auth_provider
        avatar_scale = float(profile.avatar_scale)
        avatar_position_x = int(profile.avatar_position_x)
        avatar_position_y = int(profile.avatar_position_y)
    else:
        user_id = int(profile.get("user_id", 0))
        username = str(profile.get("display_name", "") or profile.get("username", ""))
        email = str(profile.get("email", ""))
        telegram_username = str(profile.get("telegram_username", ""))
        photo = str(profile.get("photo", ""))
        auth_provider = str(profile.get("auth_provider", ""))
        avatar_scale = float(profile.get("avatar_scale", 1.0))
        avatar_position_x = int(profile.get("avatar_position_x", 50))
        avatar_position_y = int(profile.get("avatar_position_y", 50))

    return {
        "user_id": user_id,
        "username": username,
        "email": email,
        "telegram_username": telegram_username,
        "photo": photo,
        "auth_provider": auth_provider,
        "avatar_scale": avatar_scale,
        "avatar_position_x": avatar_position_x,
        "avatar_position_y": avatar_position_y,
        "unread_count": unread_count,
        "last_message_at": last_message_at.isoformat() if last_message_at else None,
    }


def _serialize_chat_message(
    message: ChatMessage,
    *,
    viewer_id: int | None = None,
    viewer_marker_at: datetime | None = None,
    peer_marker_at: datetime | None = None,
    include_original_deleted_body: bool = False,
    user_display_names: dict[int, str] | None = None,
) -> dict:
    body = message.body
    if message.is_deleted and not include_original_deleted_body:
        body = _redacted_deleted_body()

    read_by_me = False
    delivered_to_recipient: bool | None = None
    read_by_recipient: bool | None = None
    if message.scope == ChatMessage.SCOPE_PRIVATE:
        if viewer_id is not None and message.sender_id != viewer_id:
            read_by_me = bool(viewer_marker_at and viewer_marker_at >= message.created_at)
        delivered_to_recipient = peer_marker_at is not None
        read_by_recipient = bool(peer_marker_at and peer_marker_at >= message.created_at)

    sender_username = message.sender_username
    recipient_username = message.recipient_username
    if user_display_names is not None:
        sender_username = user_display_names.get(message.sender_id, sender_username)
        if message.recipient_id is not None:
            recipient_username = user_display_names.get(message.recipient_id, recipient_username)

    return {
        "id": message.id,
        "scope": message.scope,
        "sender_id": message.sender_id,
        "sender_username": sender_username,
        "recipient_id": message.recipient_id,
        "recipient_username": recipient_username,
        "body": body,
        "is_deleted": message.is_deleted,
        "edited_at": message.edited_at.isoformat() if message.edited_at else None,
        "deleted_at": message.deleted_at.isoformat() if message.deleted_at else None,
        "read_by_me": read_by_me,
        "delivered_to_recipient": delivered_to_recipient,
        "read_by_recipient": read_by_recipient,
        "created_at": message.created_at.isoformat(),
    }


def _resolve_chat_message_display_names(messages: list[ChatMessage]) -> dict[int, str]:
    user_ids: set[int] = set()
    for message in messages:
        user_ids.add(message.sender_id)
        if message.recipient_id is not None:
            user_ids.add(message.recipient_id)

    if not user_ids:
        return {}

    profiles = ChatUserProfile.objects.filter(user_id__in=user_ids)
    return {
        profile.user_id: _resolve_chat_display_name(
            user_id=profile.user_id,
            display_name=profile.display_name,
            username=profile.username,
            email=profile.email,
            telegram_username=profile.telegram_username,
        )
        for profile in profiles
    }


def _serialize_moderation_action(action: ChatModerationAction) -> dict:
    return {
        "id": action.id,
        "message_id": action.message_id,
        "action": action.action,
        "acted_by_user_id": action.acted_by_user_id,
        "acted_by_username": action.acted_by_username,
        "is_admin_action": action.is_admin_action,
        "previous_body": action.previous_body,
        "next_body": action.next_body,
        "created_at": action.created_at.isoformat(),
    }


def _resolve_chat_peer_name(peer_id: int) -> str:
    peer_profile = ChatUserProfile.objects.filter(user_id=peer_id).first()
    if peer_profile is not None:
        return _resolve_chat_display_name(
            user_id=peer_id,
            display_name=peer_profile.display_name,
            username=peer_profile.username,
            email=peer_profile.email,
            telegram_username=peer_profile.telegram_username,
        )

    django_user = User.objects.filter(id=peer_id).first()
    if django_user is not None:
        return _resolve_chat_display_name(
            user_id=peer_id,
            username=django_user.username or "",
            email=django_user.email or "",
        )

    return f"user-{peer_id}"


def _touch_chat_read_marker(*, user_id: int, scope: str, peer_id: int = ChatReadMarker.GLOBAL_PEER_ID) -> None:
    ChatReadMarker.objects.update_or_create(
        user_id=user_id,
        scope=scope,
        peer_id=peer_id,
        defaults={"last_read_at": dj_timezone.now()},
    )


def _chat_unread_summary(user_id: int) -> dict:
    global_marker = ChatReadMarker.objects.filter(
        user_id=user_id,
        scope=ChatMessage.SCOPE_GLOBAL,
        peer_id=ChatReadMarker.GLOBAL_PEER_ID,
    ).first()
    global_since = global_marker.last_read_at if global_marker else datetime.fromtimestamp(0, tz=timezone.utc)
    global_unread = ChatMessage.objects.filter(
        scope=ChatMessage.SCOPE_GLOBAL,
        is_deleted=False,
        created_at__gt=global_since,
    ).exclude(
        sender_id=user_id
    )
    global_unread_count = global_unread.count()

    private_markers = {
        marker.peer_id: marker.last_read_at
        for marker in ChatReadMarker.objects.filter(user_id=user_id, scope=ChatMessage.SCOPE_PRIVATE)
    }

    private_unread_by_user: dict[int, int] = {}
    incoming_messages = (
        ChatMessage.objects.filter(scope=ChatMessage.SCOPE_PRIVATE, recipient_id=user_id, is_deleted=False).exclude(
            sender_id=user_id
        )
    )
    fallback_since = datetime.fromtimestamp(0, tz=timezone.utc)
    for message in incoming_messages.only("sender_id", "created_at"):
        marker_since = private_markers.get(message.sender_id, fallback_since)
        if message.created_at > marker_since:
            private_unread_by_user[message.sender_id] = private_unread_by_user.get(message.sender_id, 0) + 1

    private_unread_total = sum(private_unread_by_user.values())
    by_user_payload = [
        {"user_id": peer_id, "count": count}
        for peer_id, count in sorted(private_unread_by_user.items(), key=lambda item: item[1], reverse=True)
    ]

    return {
        "global_unread": global_unread_count,
        "private_unread_total": private_unread_total,
        "private_unread_by_user": by_user_payload,
        "total_unread": global_unread_count + private_unread_total,
    }


def _paginate_chat_queryset(queryset, *, limit: int, before_id: int | None = None) -> tuple[list[ChatMessage], bool, int | None]:
    paged_query = queryset
    if before_id is not None:
        paged_query = paged_query.filter(id__lt=before_id)
    rows = list(paged_query.order_by("-id")[: limit + 1])
    has_more = len(rows) > limit
    page_rows = rows[:limit]
    page_rows.reverse()
    next_before_id = page_rows[0].id if has_more and page_rows else None
    return page_rows, has_more, next_before_id


def _filter_messages_by_query_params(queryset, request: HttpRequest):
    search_term = request.GET.get("q", "").strip()
    if search_term:
        queryset = queryset.filter(body__icontains=search_term)

    date_from = _parse_optional_datetime(request.GET.get("date_from"))
    if date_from is not None:
        queryset = queryset.filter(created_at__gte=date_from)
    date_to = _parse_optional_datetime(request.GET.get("date_to"))
    if date_to is not None:
        queryset = queryset.filter(created_at__lte=date_to)
    return queryset


def _validate_uploaded_avatar(uploaded) -> JsonResponse | None:
    if uploaded is None:
        return JsonResponse({"error": "avatar file is required"}, status=400)
    extension = Path(uploaded.name).suffix.lower()
    if extension not in ALLOWED_IMAGE_EXTENSIONS:
        return JsonResponse({"error": "Unsupported avatar file type"}, status=400)
    if uploaded.size > MAX_AVATAR_FILE_SIZE_BYTES:
        return JsonResponse({"error": "Avatar file is too large"}, status=400)
    return None


def _parse_mutation_payload(request: HttpRequest) -> tuple[dict, JsonResponse | None]:
    content_type = (request.content_type or "").lower()

    if content_type.startswith("multipart/form-data") or content_type.startswith("application/x-www-form-urlencoded"):
        return dict(request.POST.items()), None

    if not request.body:
        return {}, None

    try:
        payload = json.loads(request.body)
    except json.JSONDecodeError:
        return {}, JsonResponse({"error": "Invalid JSON"}, status=400)

    if not isinstance(payload, dict):
        return {}, JsonResponse({"error": "Invalid payload"}, status=400)
    return payload, None


def _validate_chat_display_name(display_name: str, *, user_id: int) -> JsonResponse | None:
    if len(display_name) > MAX_CHAT_DISPLAY_NAME_LENGTH:
        return JsonResponse({"error": f"Display name must be <= {MAX_CHAT_DISPLAY_NAME_LENGTH} characters"}, status=400)
    if display_name and not CHAT_DISPLAY_NAME_PATTERN.fullmatch(display_name):
        return JsonResponse({"error": "Display name contains unsupported characters"}, status=400)

    if display_name and ChatUserProfile.objects.filter(display_name__iexact=display_name).exclude(user_id=user_id).exists():
        return JsonResponse({"error": "Display name is already used"}, status=409)
    return None


def _attach_binding_flags(payload: dict, *, user_id: int) -> dict:
    has_email_auth, has_telegram_auth = _get_auth_bindings_for_user(user_id)
    email_value = _normalize_optional_text(payload.get("email"))
    telegram_value = payload.get("telegram_id")
    if email_value:
        has_email_auth = True
    if telegram_value is not None:
        has_telegram_auth = True

    payload["has_email_auth"] = has_email_auth
    payload["has_telegram_auth"] = has_telegram_auth
    payload["can_link_email"] = not has_email_auth
    payload["can_link_telegram"] = not has_telegram_auth
    return payload


def _serialize_profile_settings(*, user_id: int, profile: ChatUserProfile, telegram_id: int | None = None) -> dict:
    django_user = User.objects.filter(id=user_id).only("username", "email").first()
    email = profile.email or (django_user.email if django_user else "")
    fallback_username = (django_user.username if django_user else "") or email
    username = profile.username or profile.telegram_username or fallback_username
    avatar_presentation = _serialize_avatar_presentation(profile)
    payload = {
        "id": user_id,
        "display_name": profile.display_name,
        "username": username,
        "photo": _chat_profile_avatar_url(profile),
        "email": email,
        "telegram_id": profile.telegram_id if profile.telegram_id is not None else telegram_id,
        "telegram_username": profile.telegram_username,
        "auth_provider": profile.auth_provider or "email",
        "avatar_scale": avatar_presentation["avatar_scale"],
        "avatar_position_x": avatar_presentation["avatar_position_x"],
        "avatar_position_y": avatar_presentation["avatar_position_y"],
    }
    payload = _attach_binding_flags(payload, user_id=user_id)
    return _attach_presence_payload(payload, user_id=user_id)


def _apply_profile_to_auth_payload(payload: dict, profile: ChatUserProfile) -> dict:
    if profile.username:
        payload["username"] = profile.username
    avatar_url = _chat_profile_avatar_url(profile)
    if avatar_url:
        payload["photo"] = avatar_url
    if profile.telegram_id is not None:
        payload["telegram_id"] = profile.telegram_id
    payload["display_name"] = profile.display_name
    payload["avatar_scale"] = float(profile.avatar_scale)
    payload["avatar_position_x"] = int(profile.avatar_position_x)
    payload["avatar_position_y"] = int(profile.avatar_position_y)
    payload = _attach_binding_flags(payload, user_id=profile.user_id)
    return _attach_presence_payload(payload, user_id=profile.user_id)


def _parse_telegram_auth_payload(request: HttpRequest) -> tuple[dict | None, JsonResponse | None]:
    try:
        payload = json.loads(request.body)
    except json.JSONDecodeError:
        return None, JsonResponse({"error": "Invalid JSON"}, status=400)

    if not isinstance(payload, dict):
        return None, JsonResponse({"error": "Invalid payload"}, status=400)
    if not has_telegram_config():
        return None, JsonResponse({"error": "Server Telegram config missing"}, status=500)
    if not verify_telegram_auth(payload):
        return None, JsonResponse({"error": "Invalid Telegram auth"}, status=403)
    if time() - int(payload.get("auth_date", 0)) > 86400:
        return None, JsonResponse({"error": "Auth expired"}, status=403)
    telegram_id = _parse_optional_any_int(payload.get("id"))
    if telegram_id is None:
        return None, JsonResponse({"error": "Telegram id is required"}, status=400)
    return payload, None


def _parse_form_mutation_payload(request: HttpRequest) -> tuple[dict, object, JsonResponse | None]:
    content_type = (request.content_type or "").lower()
    if request.method != "POST" and content_type.startswith("multipart/form-data"):
        try:
            post_data, file_data = MultiPartParser(
                request.META,
                request,
                request.upload_handlers,
                request.encoding,
            ).parse()
        except MultiPartParserError:
            return {}, {}, JsonResponse({"error": "Invalid multipart payload"}, status=400)
        return dict(post_data.items()), file_data, None

    payload, parse_error = _parse_mutation_payload(request)
    return payload, request.FILES, parse_error


@csrf_exempt
def telegram_login(request: HttpRequest) -> JsonResponse:
    if request.method != "POST":
        return JsonResponse({"error": "Invalid method"}, status=405)

    user, telegram_payload_error = _parse_telegram_auth_payload(request)
    if telegram_payload_error is not None or user is None:
        return telegram_payload_error or JsonResponse({"error": "Invalid Telegram payload"}, status=400)

    telegram_id_value = _parse_optional_any_int(user.get("id"))
    if telegram_id_value is None:
        return JsonResponse({"error": "Telegram id is required"}, status=400)

    remnawave_user = _resolve_remnawave_user(telegram_id=telegram_id_value)
    resolved_email = _normalize_optional_text((remnawave_user or {}).get("email"))
    auth_user = _ensure_auth_user(
        user_id_hint=telegram_id_value,
        email=_normalize_email(resolved_email) if resolved_email else None,
        telegram_id=telegram_id_value,
    )
    if auth_user is None:
        return JsonResponse({"error": "Unable to resolve account"}, status=500)
    _, telegram_identity_error = _ensure_identity(
        user=auth_user,
        provider=AuthIdentity.PROVIDER_TELEGRAM,
        provider_user_id=_telegram_identity_key(telegram_id_value) if telegram_id_value is not None else None,
        strict=True,
    )
    if telegram_identity_error is not None:
        return telegram_identity_error
    if resolved_email:
        _, email_identity_error = _ensure_identity(
            user=auth_user,
            provider=AuthIdentity.PROVIDER_EMAIL,
            provider_user_id=_normalize_email(resolved_email),
            strict=True,
        )
        if email_identity_error is not None:
            return email_identity_error

    response = _build_auth_response(
        user_id=auth_user.id,
        username=user.get("username") or "",
        photo=user.get("photo_url") or "",
        email=auth_user.email or resolved_email,
        telegram_id=telegram_id_value,
        telegram_username=user.get("username") or None,
        auth_provider="telegram",
        remnawave_user=remnawave_user,
    )
    response_payload = json.loads(response.content)
    profile = _upsert_chat_profile(
        user_id=auth_user.id,
        username=response_payload.get("username", "") or (auth_user.email or auth_user.username or ""),
        email=response_payload.get("email") or auth_user.email or resolved_email,
        telegram_id=telegram_id_value,
        telegram_username=response_payload.get("telegram_username", "") or user.get("username") or "",
        photo=response_payload.get("photo", "") or user.get("photo_url") or "",
        auth_provider="telegram",
    )
    return JsonResponse(_apply_profile_to_auth_payload(response_payload, profile))


@csrf_exempt
def email_check(request: HttpRequest) -> JsonResponse:
    if request.method != "POST":
        return JsonResponse({"error": "Invalid method"}, status=405)

    try:
        payload = json.loads(request.body)
    except json.JSONDecodeError:
        return JsonResponse({"error": "Invalid JSON"}, status=400)

    email = _normalize_email(str(payload.get("email", "")))
    try:
        validate_email(email)
    except ValidationError:
        return JsonResponse({"error": "Invalid email"}, status=400)

    return JsonResponse({"exists": _find_user_by_email(email) is not None})


@csrf_exempt
def email_register(request: HttpRequest) -> JsonResponse:
    if request.method != "POST":
        return JsonResponse({"error": "Invalid method"}, status=405)

    try:
        payload = json.loads(request.body)
    except json.JSONDecodeError:
        return JsonResponse({"error": "Invalid JSON"}, status=400)

    email, password, error_response = _validate_email_credentials(payload)
    if error_response is not None or email is None or password is None:
        return error_response or JsonResponse({"error": "Invalid credentials"}, status=400)

    if len(password) < 6:
        return JsonResponse({"error": "Password must be at least 6 characters"}, status=400)

    existing_user = _find_user_by_email(email)
    if existing_user is not None:
        if existing_user.has_usable_password():
            return JsonResponse({"error": "Email already exists"}, status=409)

        existing_user.username = email
        existing_user.email = email
        existing_user.set_password(password)
        existing_user.last_login = dj_timezone.now()
        existing_user.save(update_fields=["username", "email", "password", "last_login"])

        remnawave_user = _resolve_remnawave_user(email=email)
        remnawave_telegram_id = _parse_optional_any_int((remnawave_user or {}).get("telegram_id"))
        _, email_identity_error = _ensure_identity(
            user=existing_user,
            provider=AuthIdentity.PROVIDER_EMAIL,
            provider_user_id=email,
            strict=True,
        )
        if email_identity_error is not None:
            return email_identity_error
        profile = _upsert_chat_profile(
            user_id=existing_user.id,
            username=existing_user.email or existing_user.username,
            email=existing_user.email or existing_user.username,
            telegram_id=remnawave_telegram_id,
            telegram_username=_normalize_optional_text((remnawave_user or {}).get("telegram_username")) or "",
            photo=_normalize_optional_text((remnawave_user or {}).get("photo")) or "",
            auth_provider="email",
        )
        payload = json.loads(
            _build_auth_response(
                user_id=existing_user.id,
                username=existing_user.email or existing_user.username,
                email=existing_user.email or existing_user.username,
                auth_provider="email",
                remnawave_user=remnawave_user,
            ).content
        )
        return JsonResponse(_apply_profile_to_auth_payload(payload, profile))

    user = User.objects.create_user(
        username=email,
        email=email,
        password=password,
    )
    _, email_identity_error = _ensure_identity(
        user=user,
        provider=AuthIdentity.PROVIDER_EMAIL,
        provider_user_id=email,
        strict=True,
    )
    if email_identity_error is not None:
        return email_identity_error
    _touch_user_last_login(user_id=user.id)
    remnawave_user = _resolve_remnawave_user(email=email)
    remnawave_telegram_id = _parse_optional_any_int((remnawave_user or {}).get("telegram_id"))
    profile = _upsert_chat_profile(
        user_id=user.id,
        username=user.email or user.username,
        email=user.email or user.username,
        telegram_id=remnawave_telegram_id,
        telegram_username=_normalize_optional_text((remnawave_user or {}).get("telegram_username")) or "",
        photo=_normalize_optional_text((remnawave_user or {}).get("photo")) or "",
        auth_provider="email",
    )
    payload = json.loads(
        _build_auth_response(
            user_id=user.id,
            username=user.email or user.username,
            email=user.email or user.username,
            auth_provider="email",
            remnawave_user=remnawave_user,
        ).content
    )
    return JsonResponse(_apply_profile_to_auth_payload(payload, profile))


@csrf_exempt
def email_login(request: HttpRequest) -> JsonResponse:
    if request.method != "POST":
        return JsonResponse({"error": "Invalid method"}, status=405)

    try:
        payload = json.loads(request.body)
    except json.JSONDecodeError:
        return JsonResponse({"error": "Invalid JSON"}, status=400)

    email, password, error_response = _validate_email_credentials(payload)
    if error_response is not None or email is None or password is None:
        return error_response or JsonResponse({"error": "Invalid credentials"}, status=400)

    user = _find_user_by_email(email)
    if user is None:
        return JsonResponse({"error": "Email not found"}, status=404)

    if not user.check_password(password):
        return JsonResponse({"error": "Invalid password"}, status=403)

    _, email_identity_error = _ensure_identity(
        user=user,
        provider=AuthIdentity.PROVIDER_EMAIL,
        provider_user_id=email,
        strict=True,
    )
    if email_identity_error is not None:
        return email_identity_error

    _touch_user_last_login(user_id=user.id)
    remnawave_user = _resolve_remnawave_user(email=email)
    remnawave_telegram_id = _parse_optional_any_int((remnawave_user or {}).get("telegram_id"))
    profile = _upsert_chat_profile(
        user_id=user.id,
        username=user.email or user.username,
        email=user.email or user.username,
        telegram_id=remnawave_telegram_id,
        telegram_username=_normalize_optional_text((remnawave_user or {}).get("telegram_username")) or "",
        photo=_normalize_optional_text((remnawave_user or {}).get("photo")) or "",
        auth_provider="email",
    )
    payload = json.loads(
        _build_auth_response(
            user_id=user.id,
            username=user.email or user.username,
            email=user.email or user.username,
            auth_provider="email",
            remnawave_user=remnawave_user,
        ).content
    )
    return JsonResponse(_apply_profile_to_auth_payload(payload, profile))


def auth_me(request: HttpRequest) -> JsonResponse:
    if request.method != "GET":
        return JsonResponse({"error": "Invalid method"}, status=405)

    user_id, email, telegram_id, username, telegram_username, photo, auth_provider = _extract_auth_identity(request)
    auth_user = _ensure_auth_user(user_id_hint=user_id, email=email, telegram_id=telegram_id)
    if auth_user is None:
        return JsonResponse({"error": "Unauthorized"}, status=401)
    resolved_user_id = auth_user.id
    resolved_email = _normalize_email(auth_user.email) if auth_user.email else email

    remnawave_user = _resolve_remnawave_user(email=resolved_email, telegram_id=telegram_id)

    resolved_auth_provider = auth_provider or ("telegram" if telegram_id is not None and not resolved_email else "email")
    _touch_user_last_login(user_id=resolved_user_id, email=resolved_email)

    response = _build_auth_response(
        user_id=resolved_user_id,
        username=username,
        photo=photo,
        email=resolved_email,
        telegram_id=telegram_id,
        telegram_username=telegram_username or (username if auth_provider == "telegram" else None),
        auth_provider=resolved_auth_provider,
        remnawave_user=remnawave_user,
    )
    response_payload = json.loads(response.content)
    profile = _upsert_chat_profile(
        user_id=resolved_user_id,
        username=response_payload.get("username", "") or username,
        email=response_payload.get("email") or resolved_email,
        telegram_id=telegram_id,
        telegram_username=response_payload.get("telegram_username", "") or telegram_username,
        photo=response_payload.get("photo", "") or photo,
        auth_provider=response_payload.get("auth_provider", "") or resolved_auth_provider,
    )
    response_payload = _apply_profile_to_auth_payload(response_payload, profile)
    return JsonResponse(response_payload)


@csrf_exempt
def auth_link_email(request: HttpRequest) -> JsonResponse:
    if request.method != "POST":
        return JsonResponse({"error": "Invalid method"}, status=405)

    user_id, current_email, telegram_id, username, telegram_username, photo, auth_provider = _extract_auth_identity(request)
    auth_user = _ensure_auth_user(user_id_hint=user_id, email=current_email, telegram_id=telegram_id)
    if auth_user is None:
        return JsonResponse({"error": "Unauthorized"}, status=401)

    try:
        payload = json.loads(request.body)
    except json.JSONDecodeError:
        return JsonResponse({"error": "Invalid JSON"}, status=400)

    if not isinstance(payload, dict):
        return JsonResponse({"error": "Invalid payload"}, status=400)

    email, password, error_response = _validate_email_credentials(payload)
    if error_response is not None or email is None or password is None:
        return error_response or JsonResponse({"error": "Invalid credentials"}, status=400)
    if len(password) < 6:
        return JsonResponse({"error": "Password must be at least 6 characters"}, status=400)

    conflicting_user = (
        User.objects.filter(Q(email__iexact=email) | Q(username__iexact=email))
        .exclude(id=auth_user.id)
        .first()
    )
    if conflicting_user is not None:
        return JsonResponse({"error": "Email already used by another account"}, status=409)

    _, identity_error = _ensure_identity(
        user=auth_user,
        provider=AuthIdentity.PROVIDER_EMAIL,
        provider_user_id=email,
        strict=True,
    )
    if identity_error is not None:
        return identity_error

    updated_user_fields: list[str] = []
    if auth_user.email.lower() != email:
        auth_user.email = email
        updated_user_fields.append("email")
    if auth_user.username != email:
        auth_user.username = email
        updated_user_fields.append("username")
    auth_user.set_password(password)
    updated_user_fields.append("password")
    auth_user.last_login = dj_timezone.now()
    updated_user_fields.append("last_login")
    auth_user.save(update_fields=list(dict.fromkeys(updated_user_fields)))

    remnawave_user = _resolve_remnawave_user(email=email, telegram_id=telegram_id)
    profile = _upsert_chat_profile(
        user_id=auth_user.id,
        username=auth_user.email or auth_user.username,
        email=auth_user.email or email,
        telegram_id=telegram_id,
        telegram_username=telegram_username,
        photo=photo,
        auth_provider=auth_provider or ("telegram" if telegram_id is not None else "email"),
    )
    response_payload = json.loads(
        _build_auth_response(
            user_id=auth_user.id,
            username=auth_user.email or auth_user.username,
            photo=photo,
            email=auth_user.email or email,
            telegram_id=telegram_id,
            telegram_username=telegram_username or (username if auth_provider == "telegram" else None),
            auth_provider=profile.auth_provider or auth_provider or "email",
            remnawave_user=remnawave_user,
        ).content
    )
    return JsonResponse(_apply_profile_to_auth_payload(response_payload, profile))


@csrf_exempt
def auth_link_telegram(request: HttpRequest) -> JsonResponse:
    if request.method != "POST":
        return JsonResponse({"error": "Invalid method"}, status=405)

    user_id, email, _, _, _, photo, auth_provider = _extract_auth_identity(request)
    auth_user = _ensure_auth_user(user_id_hint=user_id, email=email, telegram_id=None)
    if auth_user is None:
        return JsonResponse({"error": "Unauthorized"}, status=401)

    telegram_payload, telegram_payload_error = _parse_telegram_auth_payload(request)
    if telegram_payload_error is not None or telegram_payload is None:
        return telegram_payload_error or JsonResponse({"error": "Invalid Telegram payload"}, status=400)

    telegram_id = _parse_optional_any_int(telegram_payload.get("id"))
    if telegram_id is None:
        return JsonResponse({"error": "Telegram id is required"}, status=400)

    _, telegram_identity_error = _ensure_identity(
        user=auth_user,
        provider=AuthIdentity.PROVIDER_TELEGRAM,
        provider_user_id=_telegram_identity_key(telegram_id),
        strict=True,
    )
    if telegram_identity_error is not None:
        return telegram_identity_error

    remnawave_user = _resolve_remnawave_user(
        email=_normalize_email(auth_user.email) if auth_user.email else None,
        telegram_id=telegram_id,
    )
    resolved_email = _normalize_optional_text((remnawave_user or {}).get("email")) or _normalize_optional_text(auth_user.email)
    if resolved_email and auth_user.email.lower() != _normalize_email(resolved_email):
        auth_user.email = _normalize_email(resolved_email)
        if not auth_user.username or auth_user.username.startswith("tg_"):
            auth_user.username = auth_user.email
            auth_user.save(update_fields=["email", "username"])
        else:
            auth_user.save(update_fields=["email"])
    if resolved_email:
        _, email_identity_error = _ensure_identity(
            user=auth_user,
            provider=AuthIdentity.PROVIDER_EMAIL,
            provider_user_id=_normalize_email(resolved_email),
            strict=False,
        )
        if email_identity_error is not None:
            return email_identity_error

    profile = _upsert_chat_profile(
        user_id=auth_user.id,
        username=auth_user.email or auth_user.username,
        email=resolved_email or auth_user.email,
        telegram_id=telegram_id,
        telegram_username=_normalize_optional_text(telegram_payload.get("username")) or "",
        photo=_normalize_optional_text(telegram_payload.get("photo_url")) or photo,
        auth_provider=auth_provider or "telegram",
    )

    response_payload = json.loads(
        _build_auth_response(
            user_id=auth_user.id,
            username=auth_user.email or auth_user.username,
            photo=_normalize_optional_text(telegram_payload.get("photo_url")) or photo,
            email=resolved_email or auth_user.email,
            telegram_id=telegram_id,
            telegram_username=_normalize_optional_text(telegram_payload.get("username")) or None,
            auth_provider=profile.auth_provider or auth_provider or "telegram",
            remnawave_user=remnawave_user,
        ).content
    )
    return JsonResponse(_apply_profile_to_auth_payload(response_payload, profile))


@csrf_exempt
def profile_settings(request: HttpRequest) -> JsonResponse:
    user_id, email, telegram_id, username, telegram_username, photo, auth_provider = _extract_auth_identity(request)
    auth_user = _ensure_auth_user(user_id_hint=user_id, email=email, telegram_id=telegram_id)
    if auth_user is None:
        return JsonResponse({"error": "Unauthorized"}, status=401)
    resolved_user_id = auth_user.id
    resolved_email = _normalize_email(auth_user.email) if auth_user.email else email

    profile = _upsert_chat_profile(
        user_id=resolved_user_id,
        username=username,
        email=resolved_email,
        telegram_id=telegram_id,
        telegram_username=telegram_username,
        photo=photo,
        auth_provider=auth_provider or ("telegram" if telegram_id is not None else "email"),
    )

    if request.method == "GET":
        return JsonResponse(_serialize_profile_settings(user_id=resolved_user_id, profile=profile, telegram_id=telegram_id))

    if request.method not in {"PATCH", "POST"}:
        return JsonResponse({"error": "Invalid method"}, status=405)

    payload, uploaded_files, parse_error = _parse_form_mutation_payload(request)
    if parse_error is not None:
        return parse_error

    display_name_raw = payload.get("display_name")
    remove_avatar_raw = payload.get("remove_avatar")
    avatar_scale_raw = payload.get("avatar_scale")
    avatar_position_x_raw = payload.get("avatar_position_x")
    avatar_position_y_raw = payload.get("avatar_position_y")
    uploaded_avatar = uploaded_files.get("avatar")
    remove_avatar = _parse_optional_bool(remove_avatar_raw)

    if remove_avatar is None and remove_avatar_raw is not None:
        return JsonResponse({"error": "remove_avatar must be boolean"}, status=400)
    if uploaded_avatar is not None and remove_avatar:
        return JsonResponse({"error": "Cannot upload and remove avatar in one request"}, status=400)
    if not payload and uploaded_avatar is None:
        return JsonResponse({"error": "No profile fields received"}, status=400)

    normalized_avatar_scale = _parse_optional_float(avatar_scale_raw)
    if avatar_scale_raw is not None and normalized_avatar_scale is None:
        return JsonResponse({"error": "avatar_scale must be number"}, status=400)
    if normalized_avatar_scale is not None:
        normalized_avatar_scale = _clamp_avatar_scale(normalized_avatar_scale)

    normalized_avatar_position_x = _parse_optional_any_int(avatar_position_x_raw)
    if avatar_position_x_raw is not None and normalized_avatar_position_x is None:
        return JsonResponse({"error": "avatar_position_x must be integer"}, status=400)
    if normalized_avatar_position_x is not None:
        normalized_avatar_position_x = _clamp_avatar_position(normalized_avatar_position_x)

    normalized_avatar_position_y = _parse_optional_any_int(avatar_position_y_raw)
    if avatar_position_y_raw is not None and normalized_avatar_position_y is None:
        return JsonResponse({"error": "avatar_position_y must be integer"}, status=400)
    if normalized_avatar_position_y is not None:
        normalized_avatar_position_y = _clamp_avatar_position(normalized_avatar_position_y)

    update_fields: list[str] = []
    if display_name_raw is not None:
        normalized_display_name = str(display_name_raw).strip()
        display_name_error = _validate_chat_display_name(normalized_display_name, user_id=resolved_user_id)
        if display_name_error is not None:
            return display_name_error
        if profile.display_name != normalized_display_name:
            profile.display_name = normalized_display_name
            update_fields.append("display_name")

    if uploaded_avatar is not None:
        avatar_error = _validate_uploaded_avatar(uploaded_avatar)
        if avatar_error is not None:
            return avatar_error
        if profile.avatar_file and profile.avatar_file.name:
            profile.avatar_file.delete(save=False)
        profile.avatar_file.save(uploaded_avatar.name, uploaded_avatar, save=False)
        update_fields.append("avatar_file")
    elif remove_avatar:
        if profile.avatar_file and profile.avatar_file.name:
            profile.avatar_file.delete(save=False)
        profile.avatar_file = None
        update_fields.append("avatar_file")
        if _is_local_profile_avatar_url(profile.photo):
            profile.photo = ""
            update_fields.append("photo")

    if normalized_avatar_scale is not None and float(profile.avatar_scale) != float(normalized_avatar_scale):
        profile.avatar_scale = normalized_avatar_scale
        update_fields.append("avatar_scale")
    if normalized_avatar_position_x is not None and int(profile.avatar_position_x) != int(normalized_avatar_position_x):
        profile.avatar_position_x = normalized_avatar_position_x
        update_fields.append("avatar_position_x")
    if normalized_avatar_position_y is not None and int(profile.avatar_position_y) != int(normalized_avatar_position_y):
        profile.avatar_position_y = normalized_avatar_position_y
        update_fields.append("avatar_position_y")

    if update_fields:
        profile.save(update_fields=list(dict.fromkeys(update_fields + ["updated_at"])))

    return JsonResponse(_serialize_profile_settings(user_id=resolved_user_id, profile=profile, telegram_id=telegram_id))


def profile_avatar(request: HttpRequest, target_user_id: int) -> JsonResponse | FileResponse:
    if request.method != "GET":
        return JsonResponse({"error": "Invalid method"}, status=405)

    profile = ChatUserProfile.objects.filter(user_id=target_user_id).first()
    if profile is None or not profile.avatar_file or not profile.avatar_file.name:
        return JsonResponse({"error": "Avatar not found"}, status=404)

    content_type, _ = mimetypes.guess_type(profile.avatar_file.name)
    response = FileResponse(profile.avatar_file.open("rb"), content_type=content_type or "application/octet-stream")
    response["Cache-Control"] = "public, max-age=300"
    return response


def telegram_avatar(request: HttpRequest, telegram_id: int) -> HttpResponse | JsonResponse:
    if request.method != "GET":
        return JsonResponse({"error": "Invalid method"}, status=405)

    avatar_payload = get_telegram_avatar_bytes(telegram_id)
    if avatar_payload is None:
        return JsonResponse({"error": "Avatar not found"}, status=404)

    content, content_type = avatar_payload
    response = HttpResponse(content, content_type=content_type)
    response["Cache-Control"] = "public, max-age=300"
    return response


def health_check(request: HttpRequest) -> JsonResponse:
    if request.method != "GET":
        return JsonResponse({"error": "Invalid method"}, status=405)
    return JsonResponse({"status": "ok"})


@csrf_exempt
def payment_proofs_collection(request: HttpRequest) -> JsonResponse:
    user_id, username = _extract_auth_user(request)
    if user_id is None:
        return JsonResponse({"error": "Unauthorized"}, status=401)

    if request.method == "GET":
        proofs = PaymentProof.objects.filter(user_id=user_id).order_by("-created_at")
        payload = []
        for proof in proofs:
            data = _serialize_proof(proof)
            data["file_url"] = f"/api/payment-proofs/{proof.id}/file/"
            payload.append(data)
        return JsonResponse({"items": payload})

    if request.method != "POST":
        return JsonResponse({"error": "Invalid method"}, status=405)

    uploaded = request.FILES.get("file")
    if uploaded is None:
        return JsonResponse({"error": "file is required"}, status=400)

    extension = Path(uploaded.name).suffix.lower()
    if extension not in ALLOWED_IMAGE_EXTENSIONS:
        return JsonResponse({"error": "Unsupported file type"}, status=400)

    if uploaded.size > MAX_FILE_SIZE_BYTES:
        return JsonResponse({"error": "File too large"}, status=400)

    proof = PaymentProof.objects.create(
        user_id=user_id,
        username=username,
        file=uploaded,
        status=PaymentProof.STATUS_PENDING,
    )
    _notify_admins(
        kind=UserNotification.KIND_PAYMENT,
        title="Новая заявка на проверку оплаты",
        body=f"{username or user_id} отправил фото оплаты.",
        link_url="/admin-check",
    )
    data = _serialize_proof(proof)
    data["file_url"] = f"/api/payment-proofs/{proof.id}/file/"
    return JsonResponse(data, status=201)


def payment_proof_file(request: HttpRequest, proof_id: int) -> JsonResponse | FileResponse:
    user_id, _ = _extract_auth_user(request)
    _, _, telegram_id, _, _, _, _ = _extract_auth_identity(request)
    if user_id is None:
        return JsonResponse({"error": "Unauthorized"}, status=401)

    try:
        proof = PaymentProof.objects.get(id=proof_id)
    except PaymentProof.DoesNotExist:
        return JsonResponse({"error": "Not found"}, status=404)

    if proof.user_id != user_id and not _is_admin_identity(user_id, telegram_id):
        return JsonResponse({"error": "Forbidden"}, status=403)

    content_type, _ = mimetypes.guess_type(proof.file.name)
    content_type = content_type or "application/octet-stream"
    return FileResponse(proof.file.open("rb"), content_type=content_type)


def chat_users(request: HttpRequest) -> JsonResponse:
    user_id, email, telegram_id, username, telegram_username, photo, auth_provider = _extract_auth_identity(request)
    auth_user = _ensure_auth_user(user_id_hint=user_id, email=email, telegram_id=telegram_id)
    if auth_user is None:
        return JsonResponse({"error": "Unauthorized"}, status=401)
    user_id = auth_user.id
    resolved_email = _normalize_email(auth_user.email) if auth_user.email else email
    if request.method != "GET":
        return JsonResponse({"error": "Invalid method"}, status=405)

    _upsert_chat_profile(
        user_id=user_id,
        username=username,
        email=resolved_email,
        telegram_id=telegram_id,
        telegram_username=telegram_username,
        photo=photo,
        auth_provider=auth_provider,
    )
    unread_summary = _chat_unread_summary(user_id)
    unread_map = {int(item["user_id"]): int(item["count"]) for item in unread_summary["private_unread_by_user"]}

    private_messages = (
        ChatMessage.objects.filter(scope=ChatMessage.SCOPE_PRIVATE, is_deleted=False)
        .filter(Q(sender_id=user_id) | Q(recipient_id=user_id))
        .order_by("-created_at")
    )
    last_message_by_peer: dict[int, datetime] = {}
    for message in private_messages.only("sender_id", "recipient_id", "created_at"):
        peer_id = message.recipient_id if message.sender_id == user_id else message.sender_id
        if peer_id is None or peer_id == user_id:
            continue
        if peer_id not in last_message_by_peer:
            last_message_by_peer[peer_id] = message.created_at

    profile_rows = list(ChatUserProfile.objects.exclude(user_id=user_id).order_by("-updated_at", "user_id"))
    known_profile_ids = {profile.user_id for profile in profile_rows}

    fallback_users: list[dict] = []
    for django_user in User.objects.exclude(id=user_id).order_by("id").only("id", "username", "email"):
        if django_user.id in known_profile_ids:
            continue
        fallback_users.append(
            {
                "user_id": django_user.id,
                "username": django_user.username or "",
                "email": django_user.email or "",
                "telegram_username": "",
                "photo": "",
                "auth_provider": "email",
            }
        )

    items = [
        _serialize_chat_user(
            profile,
            unread_count=unread_map.get(profile.user_id, 0),
            last_message_at=last_message_by_peer.get(profile.user_id),
        )
        for profile in profile_rows
    ]
    items.extend(
        _serialize_chat_user(
            profile,
            unread_count=unread_map.get(int(profile["user_id"]), 0),
            last_message_at=last_message_by_peer.get(int(profile["user_id"])),
        )
        for profile in fallback_users
    )
    items.sort(
        key=lambda item: (
            item["last_message_at"] or "",
            item["unread_count"],
            item["username"] or item["email"] or str(item["user_id"]),
        ),
        reverse=True,
    )
    return JsonResponse({"items": items})


@csrf_exempt
def chat_messages(request: HttpRequest) -> JsonResponse:
    user_id, email, telegram_id, username, telegram_username, photo, auth_provider = _extract_auth_identity(request)
    auth_user = _ensure_auth_user(user_id_hint=user_id, email=email, telegram_id=telegram_id)
    if auth_user is None:
        return JsonResponse({"error": "Unauthorized"}, status=401)
    user_id = auth_user.id
    resolved_email = _normalize_email(auth_user.email) if auth_user.email else email

    profile = _upsert_chat_profile(
        user_id=user_id,
        username=username,
        email=resolved_email,
        telegram_id=telegram_id,
        telegram_username=telegram_username,
        photo=photo,
        auth_provider=auth_provider,
    )
    sender_name = _resolve_chat_display_name(
        user_id=user_id,
        display_name=profile.display_name,
        username=username,
        email=resolved_email,
        telegram_username=telegram_username,
    )

    if request.method == "GET":
        scope = request.GET.get("scope", ChatMessage.SCOPE_GLOBAL).strip()
        if scope not in {ChatMessage.SCOPE_GLOBAL, ChatMessage.SCOPE_PRIVATE}:
            return JsonResponse({"error": "Invalid scope"}, status=400)

        limit = _parse_chat_limit(request)
        before_id = _parse_optional_chat_before_id(request)

        if scope == ChatMessage.SCOPE_GLOBAL:
            messages_query = _filter_messages_by_query_params(ChatMessage.objects.filter(scope=scope), request)
            messages, has_more, next_before_id = _paginate_chat_queryset(messages_query, limit=limit, before_id=before_id)
            user_display_names = _resolve_chat_message_display_names(messages)
            _touch_chat_read_marker(user_id=user_id, scope=ChatMessage.SCOPE_GLOBAL)
            publish_chat_event(
                {
                    "event": "read_marker_updated",
                    "scope": ChatMessage.SCOPE_GLOBAL,
                    "user_id": user_id,
                    "peer_id": ChatReadMarker.GLOBAL_PEER_ID,
                }
            )
            return JsonResponse(
                {
                    "scope": scope,
                    "items": [
                        _serialize_chat_message(message, viewer_id=user_id, user_display_names=user_display_names)
                        for message in messages
                    ],
                    "pagination": {"has_more": has_more, "next_before_id": next_before_id, "limit": limit},
                }
            )

        raw_peer_id = request.GET.get("peer_id", "").strip()
        if not raw_peer_id.isdigit():
            return JsonResponse({"error": "peer_id is required for private chat"}, status=400)
        peer_id = int(raw_peer_id)
        if peer_id == user_id:
            return JsonResponse({"error": "Cannot open private chat with yourself"}, status=400)

        messages_query = (
            ChatMessage.objects.filter(scope=scope)
            .filter(
                (Q(sender_id=user_id) & Q(recipient_id=peer_id))
                | (Q(sender_id=peer_id) & Q(recipient_id=user_id))
            )
        )
        messages_query = _filter_messages_by_query_params(messages_query, request)
        messages, has_more, next_before_id = _paginate_chat_queryset(messages_query, limit=limit, before_id=before_id)
        user_display_names = _resolve_chat_message_display_names(messages)
        _touch_chat_read_marker(user_id=user_id, scope=ChatMessage.SCOPE_PRIVATE, peer_id=peer_id)
        publish_chat_event(
            {
                "event": "read_marker_updated",
                "scope": ChatMessage.SCOPE_PRIVATE,
                "user_id": user_id,
                "peer_id": peer_id,
                "sender_id": user_id,
                "recipient_id": peer_id,
            }
        )
        viewer_marker = ChatReadMarker.objects.filter(
            user_id=user_id,
            scope=ChatMessage.SCOPE_PRIVATE,
            peer_id=peer_id,
        ).first()
        peer_marker = ChatReadMarker.objects.filter(
            user_id=peer_id,
            scope=ChatMessage.SCOPE_PRIVATE,
            peer_id=user_id,
        ).first()

        return JsonResponse(
            {
                "scope": scope,
                "peer_id": peer_id,
                "items": [
                    _serialize_chat_message(
                        message,
                        viewer_id=user_id,
                        viewer_marker_at=viewer_marker.last_read_at if viewer_marker else None,
                        peer_marker_at=peer_marker.last_read_at if peer_marker else None,
                        user_display_names=user_display_names,
                    )
                    for message in messages
                ],
                "pagination": {"has_more": has_more, "next_before_id": next_before_id, "limit": limit},
            }
        )

    if request.method != "POST":
        return JsonResponse({"error": "Invalid method"}, status=405)

    try:
        payload = json.loads(request.body)
    except json.JSONDecodeError:
        return JsonResponse({"error": "Invalid JSON"}, status=400)

    scope = str(payload.get("scope", ChatMessage.SCOPE_GLOBAL)).strip()
    if scope not in {ChatMessage.SCOPE_GLOBAL, ChatMessage.SCOPE_PRIVATE}:
        return JsonResponse({"error": "Invalid scope"}, status=400)

    body = str(payload.get("body", "")).strip()
    if not body:
        return JsonResponse({"error": "Message body is required"}, status=400)
    if len(body) > MAX_CHAT_MESSAGE_LENGTH:
        return JsonResponse({"error": f"Message is too long (max {MAX_CHAT_MESSAGE_LENGTH})"}, status=400)
    client_message_id = str(payload.get("client_message_id", "")).strip()[:64]

    if client_message_id:
        duplicate = ChatMessage.objects.filter(sender_id=user_id, client_message_id=client_message_id).first()
        if duplicate is not None:
            peer_marker = None
            if duplicate.scope == ChatMessage.SCOPE_PRIVATE and duplicate.recipient_id is not None:
                peer_marker = ChatReadMarker.objects.filter(
                    user_id=duplicate.recipient_id,
                    scope=ChatMessage.SCOPE_PRIVATE,
                    peer_id=user_id,
                ).first()
            return JsonResponse(
                _serialize_chat_message(
                    duplicate,
                    viewer_id=user_id,
                    peer_marker_at=peer_marker.last_read_at if peer_marker else None,
                )
            )

    if _chat_rate_limit_exceeded(user_id):
        return JsonResponse(
            {
                "error": (
                    "Too many messages. "
                    f"Limit: {CHAT_RATE_LIMIT_MAX_MESSAGES} messages per {CHAT_RATE_LIMIT_WINDOW_SECONDS}s"
                )
            },
            status=429,
        )

    recipient_id: int | None = None
    recipient_username = ""
    if scope == ChatMessage.SCOPE_PRIVATE:
        raw_recipient_id = str(payload.get("recipient_id", "")).strip()
        if not raw_recipient_id.isdigit():
            return JsonResponse({"error": "recipient_id is required for private chat"}, status=400)
        recipient_id = int(raw_recipient_id)
        if recipient_id == user_id:
            return JsonResponse({"error": "Cannot send private message to yourself"}, status=400)
        recipient_username = _resolve_chat_peer_name(recipient_id)

    try:
        with transaction.atomic():
            message = ChatMessage.objects.create(
                scope=scope,
                sender_id=user_id,
                sender_username=sender_name,
                recipient_id=recipient_id,
                recipient_username=recipient_username,
                client_message_id=client_message_id,
                body=body,
            )
    except IntegrityError:
        if not client_message_id:
            return JsonResponse({"error": "Conflict while sending message"}, status=409)
        duplicate = ChatMessage.objects.filter(sender_id=user_id, client_message_id=client_message_id).first()
        if duplicate is None:
            return JsonResponse({"error": "Conflict while sending message"}, status=409)
        return JsonResponse(_serialize_chat_message(duplicate, viewer_id=user_id))

    peer_marker = None
    if recipient_id is not None:
        peer_marker = ChatReadMarker.objects.filter(
            user_id=recipient_id,
            scope=ChatMessage.SCOPE_PRIVATE,
            peer_id=user_id,
        ).first()
        _create_user_notification(
            user_id=recipient_id,
            kind=UserNotification.KIND_CHAT,
            title="Новое личное сообщение",
            body=f"{sender_name}: {body[:140]}",
            link_url="/chat",
        )
    payload = _serialize_chat_message(
        message,
        viewer_id=user_id,
        peer_marker_at=peer_marker.last_read_at if peer_marker else None,
    )
    publish_chat_event(
        {
            "event": "message_created",
            "scope": message.scope,
            "message_id": message.id,
            "sender_id": message.sender_id,
            "recipient_id": message.recipient_id,
        }
    )
    return JsonResponse(payload, status=201)


@csrf_exempt
def chat_message_item(request: HttpRequest, message_id: int) -> JsonResponse:
    user_id, email, telegram_id, username, telegram_username, photo, auth_provider = _extract_auth_identity(request)
    auth_user = _ensure_auth_user(user_id_hint=user_id, email=email, telegram_id=telegram_id)
    if auth_user is None:
        return JsonResponse({"error": "Unauthorized"}, status=401)
    user_id = auth_user.id
    resolved_email = _normalize_email(auth_user.email) if auth_user.email else email
    if request.method not in {"PATCH", "DELETE"}:
        return JsonResponse({"error": "Invalid method"}, status=405)

    try:
        message = ChatMessage.objects.get(id=message_id)
    except ChatMessage.DoesNotExist:
        return JsonResponse({"error": "Message not found"}, status=404)

    is_admin = _is_admin_identity(user_id, telegram_id)
    can_manage = is_admin or message.sender_id == user_id
    if not can_manage:
        return JsonResponse({"error": "Forbidden"}, status=403)

    profile = _upsert_chat_profile(
        user_id=user_id,
        username=username,
        email=resolved_email,
        telegram_id=telegram_id,
        telegram_username=telegram_username,
        photo=photo,
        auth_provider=auth_provider,
    )
    actor_name = _resolve_chat_display_name(
        user_id=user_id,
        display_name=profile.display_name,
        username=username,
        email=resolved_email,
        telegram_username=telegram_username,
    )

    if request.method == "PATCH":
        try:
            payload = json.loads(request.body)
        except json.JSONDecodeError:
            return JsonResponse({"error": "Invalid JSON"}, status=400)

        if message.is_deleted:
            return JsonResponse({"error": "Deleted message cannot be edited"}, status=409)

        new_body = str(payload.get("body", "")).strip()
        if not new_body:
            return JsonResponse({"error": "Message body is required"}, status=400)
        if len(new_body) > MAX_CHAT_MESSAGE_LENGTH:
            return JsonResponse({"error": f"Message is too long (max {MAX_CHAT_MESSAGE_LENGTH})"}, status=400)
        if new_body == message.body:
            return JsonResponse(_serialize_chat_message(message, viewer_id=user_id))

        previous_body = message.body
        message.body = new_body
        message.edited_at = dj_timezone.now()
        message.save(update_fields=["body", "edited_at"])

        ChatModerationAction.objects.create(
            message=message,
            action=ChatModerationAction.ACTION_EDIT,
            acted_by_user_id=user_id,
            acted_by_username=actor_name,
            is_admin_action=is_admin and message.sender_id != user_id,
            previous_body=previous_body,
            next_body=new_body,
        )
        payload = _serialize_chat_message(message, viewer_id=user_id)
        publish_chat_event(
            {
                "event": "message_updated",
                "scope": message.scope,
                "message_id": message.id,
                "sender_id": message.sender_id,
                "recipient_id": message.recipient_id,
            }
        )
        return JsonResponse(payload)

    if message.is_deleted:
        return JsonResponse(_serialize_chat_message(message, viewer_id=user_id))

    previous_body = message.body
    message.is_deleted = True
    message.deleted_at = dj_timezone.now()
    message.deleted_by_user_id = user_id
    message.deleted_by_admin = is_admin and message.sender_id != user_id
    message.save(update_fields=["is_deleted", "deleted_at", "deleted_by_user_id", "deleted_by_admin"])

    ChatModerationAction.objects.create(
        message=message,
        action=ChatModerationAction.ACTION_DELETE,
        acted_by_user_id=user_id,
        acted_by_username=actor_name,
        is_admin_action=is_admin and message.sender_id != user_id,
        previous_body=previous_body,
        next_body="",
    )
    payload = _serialize_chat_message(message, viewer_id=user_id)
    publish_chat_event(
        {
            "event": "message_deleted",
            "scope": message.scope,
            "message_id": message.id,
            "sender_id": message.sender_id,
            "recipient_id": message.recipient_id,
        }
    )
    return JsonResponse(payload)


@csrf_exempt
def chat_read_marker(request: HttpRequest) -> JsonResponse:
    user_id, email, telegram_id, _, _, _, _ = _extract_auth_identity(request)
    auth_user = _ensure_auth_user(user_id_hint=user_id, email=email, telegram_id=telegram_id)
    if auth_user is None:
        return JsonResponse({"error": "Unauthorized"}, status=401)
    user_id = auth_user.id
    if request.method != "POST":
        return JsonResponse({"error": "Invalid method"}, status=405)

    try:
        payload = json.loads(request.body)
    except json.JSONDecodeError:
        return JsonResponse({"error": "Invalid JSON"}, status=400)

    scope = str(payload.get("scope", ChatMessage.SCOPE_GLOBAL)).strip()
    if scope not in {ChatMessage.SCOPE_GLOBAL, ChatMessage.SCOPE_PRIVATE}:
        return JsonResponse({"error": "Invalid scope"}, status=400)

    if scope == ChatMessage.SCOPE_GLOBAL:
        _touch_chat_read_marker(user_id=user_id, scope=scope)
        publish_chat_event(
            {
                "event": "read_marker_updated",
                "scope": ChatMessage.SCOPE_GLOBAL,
                "user_id": user_id,
                "peer_id": ChatReadMarker.GLOBAL_PEER_ID,
            }
        )
        return JsonResponse({"ok": True})

    raw_peer_id = str(payload.get("peer_id", "")).strip()
    if not raw_peer_id.isdigit():
        return JsonResponse({"error": "peer_id is required for private chat"}, status=400)
    peer_id = int(raw_peer_id)
    if peer_id == user_id:
        return JsonResponse({"error": "Cannot mark yourself as peer"}, status=400)
    _touch_chat_read_marker(user_id=user_id, scope=scope, peer_id=peer_id)
    publish_chat_event(
        {
            "event": "read_marker_updated",
            "scope": ChatMessage.SCOPE_PRIVATE,
            "user_id": user_id,
            "peer_id": peer_id,
            "sender_id": user_id,
            "recipient_id": peer_id,
        }
    )
    return JsonResponse({"ok": True})


def chat_unread(request: HttpRequest) -> JsonResponse:
    user_id, email, telegram_id, _, _, _, _ = _extract_auth_identity(request)
    auth_user = _ensure_auth_user(user_id_hint=user_id, email=email, telegram_id=telegram_id)
    if auth_user is None:
        return JsonResponse({"error": "Unauthorized"}, status=401)
    user_id = auth_user.id
    if request.method != "GET":
        return JsonResponse({"error": "Invalid method"}, status=405)
    return JsonResponse(_chat_unread_summary(user_id))


@csrf_exempt
def notifications_collection(request: HttpRequest) -> JsonResponse:
    user_id, email, telegram_id, _, _, _, _ = _extract_auth_identity(request)
    auth_user = _ensure_auth_user(user_id_hint=user_id, email=email, telegram_id=telegram_id)
    if auth_user is None:
        return JsonResponse({"error": "Unauthorized"}, status=401)
    user_id = auth_user.id

    if request.method == "GET":
        raw_limit = request.GET.get("limit", "20").strip()
        raw_unread_only = request.GET.get("unread_only", "").strip()
        if raw_limit and not raw_limit.isdigit():
            return JsonResponse({"error": "limit must be integer"}, status=400)
        limit = max(1, min(100, int(raw_limit or "20")))
        unread_only = _parse_optional_bool(raw_unread_only) if raw_unread_only else False
        query = UserNotification.objects.filter(user_id=user_id)
        if unread_only:
            query = query.filter(is_read=False)
        items = list(query.order_by("-id")[:limit])
        unread_count = UserNotification.objects.filter(user_id=user_id, is_read=False).count()
        return JsonResponse(
            {
                "items": [_serialize_notification(notification) for notification in items],
                "unread_count": unread_count,
            }
        )

    if request.method != "PATCH":
        return JsonResponse({"error": "Invalid method"}, status=405)

    UserNotification.objects.filter(user_id=user_id, is_read=False).update(is_read=True, read_at=dj_timezone.now())
    publish_chat_event({"event": "notifications_read", "scope": "notification", "user_id": user_id})
    return JsonResponse({"ok": True, "unread_count": 0})


@csrf_exempt
def notification_item(request: HttpRequest, notification_id: int) -> JsonResponse:
    user_id, email, telegram_id, _, _, _, _ = _extract_auth_identity(request)
    auth_user = _ensure_auth_user(user_id_hint=user_id, email=email, telegram_id=telegram_id)
    if auth_user is None:
        return JsonResponse({"error": "Unauthorized"}, status=401)
    user_id = auth_user.id

    if request.method != "PATCH":
        return JsonResponse({"error": "Invalid method"}, status=405)

    try:
        notification = UserNotification.objects.get(id=notification_id, user_id=user_id)
    except UserNotification.DoesNotExist:
        return JsonResponse({"error": "Notification not found"}, status=404)

    payload, parse_error = _parse_mutation_payload(request)
    if parse_error is not None:
        return parse_error

    is_read = _parse_optional_bool(payload.get("is_read"))
    if is_read is None:
        is_read = True
    notification.is_read = is_read
    notification.read_at = dj_timezone.now() if is_read else None
    notification.save(update_fields=["is_read", "read_at"])
    publish_chat_event({"event": "notification_updated", "scope": "notification", "user_id": user_id})
    return JsonResponse(_serialize_notification(notification))


def admin_chat_messages(request: HttpRequest) -> JsonResponse:
    user_id, _ = _extract_auth_user(request)
    _, _, telegram_id, _, _, _, _ = _extract_auth_identity(request)
    if user_id is None:
        return JsonResponse({"error": "Unauthorized"}, status=401)
    if not _is_admin_identity(user_id, telegram_id):
        return JsonResponse({"error": "Forbidden"}, status=403)
    if request.method != "GET":
        return JsonResponse({"error": "Invalid method"}, status=405)

    scope = request.GET.get("scope", "all").strip()
    if scope not in {"all", ChatMessage.SCOPE_GLOBAL, ChatMessage.SCOPE_PRIVATE}:
        return JsonResponse({"error": "Invalid scope"}, status=400)

    limit = _parse_chat_limit(request)
    before_id = _parse_optional_chat_before_id(request)
    raw_user_id = request.GET.get("user_id", "").strip()
    raw_peer_id = request.GET.get("peer_id", "").strip()

    messages_query = ChatMessage.objects.all()
    if scope != "all":
        messages_query = messages_query.filter(scope=scope)
    messages_query = _filter_messages_by_query_params(messages_query, request)

    if raw_user_id:
        if not raw_user_id.isdigit():
            return JsonResponse({"error": "user_id must be integer"}, status=400)
        filter_user_id = int(raw_user_id)
        messages_query = messages_query.filter(Q(sender_id=filter_user_id) | Q(recipient_id=filter_user_id))
    else:
        filter_user_id = None

    if raw_peer_id:
        if not raw_peer_id.isdigit():
            return JsonResponse({"error": "peer_id must be integer"}, status=400)
        filter_peer_id = int(raw_peer_id)
        if filter_user_id is not None:
            messages_query = messages_query.filter(
                (Q(sender_id=filter_user_id) & Q(recipient_id=filter_peer_id))
                | (Q(sender_id=filter_peer_id) & Q(recipient_id=filter_user_id))
            )
        else:
            messages_query = messages_query.filter(Q(sender_id=filter_peer_id) | Q(recipient_id=filter_peer_id))

    messages, has_more, next_before_id = _paginate_chat_queryset(messages_query, limit=limit, before_id=before_id)
    user_display_names = _resolve_chat_message_display_names(messages)
    return JsonResponse(
        {
            "scope": scope,
            "items": [
                _serialize_chat_message(
                    message,
                    include_original_deleted_body=True,
                    user_display_names=user_display_names,
                )
                for message in messages
            ],
            "pagination": {"has_more": has_more, "next_before_id": next_before_id, "limit": limit},
        }
    )


def admin_chat_actions(request: HttpRequest) -> JsonResponse:
    user_id, _ = _extract_auth_user(request)
    _, _, telegram_id, _, _, _, _ = _extract_auth_identity(request)
    if user_id is None:
        return JsonResponse({"error": "Unauthorized"}, status=401)
    if not _is_admin_identity(user_id, telegram_id):
        return JsonResponse({"error": "Forbidden"}, status=403)
    if request.method != "GET":
        return JsonResponse({"error": "Invalid method"}, status=405)

    limit = _parse_chat_limit(request)
    before_id = _parse_optional_chat_before_id(request)
    raw_action = request.GET.get("action", "").strip()
    raw_message_id = request.GET.get("message_id", "").strip()
    raw_actor_id = request.GET.get("acted_by_user_id", "").strip()

    actions_query = ChatModerationAction.objects.select_related("message")
    if raw_action:
        if raw_action not in {ChatModerationAction.ACTION_EDIT, ChatModerationAction.ACTION_DELETE}:
            return JsonResponse({"error": "Invalid action filter"}, status=400)
        actions_query = actions_query.filter(action=raw_action)
    if raw_message_id:
        if not raw_message_id.isdigit():
            return JsonResponse({"error": "message_id must be integer"}, status=400)
        actions_query = actions_query.filter(message_id=int(raw_message_id))
    if raw_actor_id:
        if not raw_actor_id.isdigit():
            return JsonResponse({"error": "acted_by_user_id must be integer"}, status=400)
        actions_query = actions_query.filter(acted_by_user_id=int(raw_actor_id))

    if before_id is not None:
        actions_query = actions_query.filter(id__lt=before_id)
    rows = list(actions_query.order_by("-id")[: limit + 1])
    has_more = len(rows) > limit
    rows = rows[:limit]
    rows.reverse()
    next_before_id = rows[0].id if has_more and rows else None

    return JsonResponse(
        {
            "items": [_serialize_moderation_action(action) for action in rows],
            "pagination": {"has_more": has_more, "next_before_id": next_before_id, "limit": limit},
        }
    )


def admin_payment_proof_users(request: HttpRequest) -> JsonResponse:
    user_id, _ = _extract_auth_user(request)
    _, _, telegram_id, _, _, _, _ = _extract_auth_identity(request)
    if user_id is None:
        return JsonResponse({"error": "Unauthorized"}, status=401)
    if not _is_admin_identity(user_id, telegram_id):
        return JsonResponse({"error": "Forbidden"}, status=403)
    if request.method != "GET":
        return JsonResponse({"error": "Invalid method"}, status=405)

    rows = (
        PaymentProof.objects.values("user_id")
        .annotate(
            username=Max("username"),
            last_created=Max("created_at"),
            pending_count=Count("id", filter=Q(status=PaymentProof.STATUS_PENDING)),
        )
        .order_by("-last_created")
    )

    items = []
    for row in rows:
        items.append(
            {
                "user_id": row["user_id"],
                "username": row.get("username") or "",
                "pending_count": row.get("pending_count", 0),
            }
        )

    return JsonResponse({"items": items})


def admin_users(request: HttpRequest) -> JsonResponse:
    user_id, _ = _extract_auth_user(request)
    _, _, telegram_id, _, _, _, _ = _extract_auth_identity(request)
    if user_id is None:
        return JsonResponse({"error": "Unauthorized"}, status=401)
    if not _is_admin_identity(user_id, telegram_id):
        return JsonResponse({"error": "Forbidden"}, status=403)
    if request.method != "GET":
        return JsonResponse({"error": "Invalid method"}, status=405)

    raw_limit = request.GET.get("limit", str(DEFAULT_ADMIN_USERS_PAGE_SIZE)).strip()
    raw_offset = request.GET.get("offset", "0").strip()
    if not raw_limit.isdigit() or not raw_offset.isdigit():
        return JsonResponse({"error": "limit and offset must be positive integers"}, status=400)

    limit = max(1, min(500, int(raw_limit)))
    offset = int(raw_offset)
    online_after = dj_timezone.now() - timedelta(minutes=ONLINE_WINDOW_MINUTES)
    search_term = request.GET.get("q", "").strip()
    filter_name = request.GET.get("filter", "all").strip()
    if filter_name not in {"all", "online", "remnawave", "need-password", "payment-pending"}:
        return JsonResponse({"error": "Invalid filter"}, status=400)

    users_queryset = User.objects.all().order_by("-last_login", "-date_joined", "id")
    if search_term:
        search_filter = Q(username__icontains=search_term) | Q(email__icontains=search_term)
        if search_term.isdigit():
            search_filter |= Q(id=int(search_term))
        matching_profile_ids = ChatUserProfile.objects.filter(
            Q(display_name__icontains=search_term)
            | Q(username__icontains=search_term)
            | Q(email__icontains=search_term)
            | Q(telegram_username__icontains=search_term)
        ).values_list("user_id", flat=True)
        users_queryset = users_queryset.filter(search_filter | Q(id__in=matching_profile_ids))

    if filter_name == "online":
        users_queryset = users_queryset.filter(last_login__gte=online_after)
    elif filter_name == "need-password":
        users_queryset = users_queryset.filter(password__startswith="!")
    elif filter_name == "payment-pending":
        pending_user_ids = PaymentProof.objects.filter(status=PaymentProof.STATUS_PENDING).values_list("user_id", flat=True)
        users_queryset = users_queryset.filter(id__in=pending_user_ids)

    filtered_total = users_queryset.count()
    if filter_name == "remnawave":
        candidate_users = list(users_queryset[:1000])
        serialized_candidates = [
            _serialize_admin_user(user, online_after=online_after)
            for user in candidate_users
        ]
        remnawave_items = [item for item in serialized_candidates if item["has_remnawave_access"]]
        items = remnawave_items[offset : offset + limit]
        filtered_total = len(remnawave_items)
    else:
        users = list(users_queryset[offset : offset + limit])
        items = [_serialize_admin_user(user, online_after=online_after) for user in users]

    remnawave_access_users = sum(1 for item in items if item["has_remnawave_access"])
    online_users = User.objects.filter(last_login__gte=online_after).count()
    users_without_password = User.objects.filter(password__startswith="!").count()
    today_start = dj_timezone.now().replace(hour=0, minute=0, second=0, microsecond=0)
    active_today = User.objects.filter(last_login__gte=today_start).count()
    total_users = User.objects.count()

    return JsonResponse(
        {
            "items": items,
            "metrics": {
                "total_users": total_users,
                "online_users": online_users,
                "online_window_minutes": ONLINE_WINDOW_MINUTES,
                "remnawave_access_users": remnawave_access_users,
                "users_without_password": users_without_password,
                "active_today": active_today,
            },
            "pagination": {
                "limit": limit,
                "offset": offset,
                "has_more": offset + len(items) < filtered_total,
                "filtered_total": filtered_total,
            },
        }
    )


def admin_payment_proofs(request: HttpRequest) -> JsonResponse:
    user_id, _ = _extract_auth_user(request)
    _, _, telegram_id, _, _, _, _ = _extract_auth_identity(request)
    if user_id is None:
        return JsonResponse({"error": "Unauthorized"}, status=401)
    if not _is_admin_identity(user_id, telegram_id):
        return JsonResponse({"error": "Forbidden"}, status=403)
    if request.method != "GET":
        return JsonResponse({"error": "Invalid method"}, status=405)

    target_user_id = request.GET.get("user_id", "").strip()
    if not target_user_id.isdigit():
        return JsonResponse({"error": "user_id is required"}, status=400)

    proofs = PaymentProof.objects.filter(user_id=int(target_user_id)).order_by("-created_at")
    items = []
    for proof in proofs:
        item = _serialize_proof(proof)
        item["file_url"] = f"/api/payment-proofs/{proof.id}/file/"
        items.append(item)
    return JsonResponse({"items": items})


@csrf_exempt
def admin_update_user_credentials(request: HttpRequest, target_user_id: int) -> JsonResponse:
    user_id, _ = _extract_auth_user(request)
    _, _, telegram_id, _, _, _, _ = _extract_auth_identity(request)
    if user_id is None:
        return JsonResponse({"error": "Unauthorized"}, status=401)
    if not _is_admin_identity(user_id, telegram_id):
        return JsonResponse({"error": "Forbidden"}, status=403)
    if request.method not in {"GET", "PATCH"}:
        return JsonResponse({"error": "Invalid method"}, status=405)

    try:
        user = User.objects.get(id=target_user_id)
    except User.DoesNotExist:
        return JsonResponse({"error": "User not found"}, status=404)

    if request.method == "GET":
        online_after = dj_timezone.now() - timedelta(minutes=ONLINE_WINDOW_MINUTES)
        return JsonResponse(_serialize_admin_user_detail(user, online_after=online_after))

    payload, uploaded_files, parse_error = _parse_form_mutation_payload(request)
    if parse_error is not None:
        return parse_error

    profile, _ = ChatUserProfile.objects.get_or_create(user_id=target_user_id)

    uploaded_avatar = uploaded_files.get("avatar")
    remove_avatar_raw = payload.get("remove_avatar")
    remove_avatar = _parse_optional_bool(remove_avatar_raw)
    if remove_avatar is None and remove_avatar_raw is not None:
        return JsonResponse({"error": "remove_avatar must be boolean"}, status=400)
    if uploaded_avatar is not None and remove_avatar:
        return JsonResponse({"error": "Cannot upload and remove avatar in one request"}, status=400)

    next_login = payload.get("login")
    next_password = payload.get("password")
    next_display_name = payload.get("display_name")
    next_chat_username = payload.get("chat_username")
    next_chat_email = payload.get("chat_email")
    next_telegram_id = payload.get("telegram_id")
    next_telegram_username = payload.get("telegram_username")
    next_photo = payload.get("photo")
    next_auth_provider = payload.get("auth_provider")

    update_login = next_login is not None
    update_password = next_password is not None

    update_profile_data = any(
        value is not None
        for value in (
            next_display_name,
            next_chat_username,
            next_chat_email,
            next_telegram_id,
            next_telegram_username,
            next_photo,
            next_auth_provider,
        )
    )
    if not update_login and not update_password and not update_profile_data and uploaded_avatar is None and not remove_avatar:
        return JsonResponse({"error": "Nothing to update"}, status=400)

    updated_user_fields: list[str] = []
    updated_profile_fields: list[str] = []

    normalized_login_value: str | None = None
    if update_login:
        normalized_login = _normalize_email(str(next_login))
        try:
            validate_email(normalized_login)
        except ValidationError:
            return JsonResponse({"error": "Invalid login/email"}, status=400)

        conflict = (
            User.objects.filter(Q(email__iexact=normalized_login) | Q(username__iexact=normalized_login))
            .exclude(id=target_user_id)
            .exists()
        )
        if conflict:
            return JsonResponse({"error": "Login already used by another account"}, status=409)

        user.username = normalized_login
        user.email = normalized_login
        updated_user_fields.extend(["username", "email"])
        normalized_login_value = normalized_login

    if update_password:
        password = str(next_password)
        if len(password) < 6:
            return JsonResponse({"error": "Password must be at least 6 characters"}, status=400)
        user.set_password(password)
        updated_user_fields.append("password")

    if next_display_name is not None:
        normalized_display_name = str(next_display_name).strip()
        display_name_error = _validate_chat_display_name(normalized_display_name, user_id=target_user_id)
        if display_name_error is not None:
            return display_name_error
        if profile.display_name != normalized_display_name:
            profile.display_name = normalized_display_name
            updated_profile_fields.append("display_name")

    if next_chat_username is not None:
        normalized_chat_username = str(next_chat_username).strip()[:255]
        if profile.username != normalized_chat_username:
            profile.username = normalized_chat_username
            updated_profile_fields.append("username")

    if next_chat_email is not None:
        normalized_chat_email = _normalize_email(str(next_chat_email)) if str(next_chat_email).strip() else ""
        if normalized_chat_email:
            try:
                validate_email(normalized_chat_email)
            except ValidationError:
                return JsonResponse({"error": "Invalid chat_email"}, status=400)
        if profile.email != normalized_chat_email:
            profile.email = normalized_chat_email
            updated_profile_fields.append("email")
    elif normalized_login_value is not None and profile.email != normalized_login_value:
        profile.email = normalized_login_value
        updated_profile_fields.append("email")

    if next_telegram_username is not None:
        normalized_telegram_username = str(next_telegram_username).strip()[:255]
        if profile.telegram_username != normalized_telegram_username:
            profile.telegram_username = normalized_telegram_username
            updated_profile_fields.append("telegram_username")

    if next_telegram_id is not None:
        normalized_telegram_id = _parse_optional_any_int(next_telegram_id)
        if normalized_telegram_id is None and str(next_telegram_id).strip():
            return JsonResponse({"error": "telegram_id must be integer"}, status=400)
        if normalized_telegram_id is not None:
            ChatUserProfile.objects.filter(telegram_id=normalized_telegram_id).exclude(user_id=target_user_id).update(
                telegram_id=None
            )
        if profile.telegram_id != normalized_telegram_id:
            profile.telegram_id = normalized_telegram_id
            updated_profile_fields.append("telegram_id")

    if next_photo is not None:
        normalized_photo = str(next_photo).strip()[:2048]
        if profile.photo != normalized_photo:
            profile.photo = normalized_photo
            updated_profile_fields.append("photo")

    if next_auth_provider is not None:
        normalized_auth_provider = str(next_auth_provider).strip().lower()
        if normalized_auth_provider not in {"", "email", "telegram"}:
            return JsonResponse({"error": "Invalid auth_provider"}, status=400)
        if profile.auth_provider != normalized_auth_provider:
            profile.auth_provider = normalized_auth_provider
            updated_profile_fields.append("auth_provider")

    if uploaded_avatar is not None:
        avatar_error = _validate_uploaded_avatar(uploaded_avatar)
        if avatar_error is not None:
            return avatar_error
        if profile.avatar_file and profile.avatar_file.name:
            profile.avatar_file.delete(save=False)
        profile.avatar_file.save(uploaded_avatar.name, uploaded_avatar, save=False)
        updated_profile_fields.append("avatar_file")
    elif remove_avatar:
        if profile.avatar_file and profile.avatar_file.name:
            profile.avatar_file.delete(save=False)
        profile.avatar_file = None
        updated_profile_fields.append("avatar_file")
        if _is_local_profile_avatar_url(profile.photo):
            profile.photo = ""
            updated_profile_fields.append("photo")

    if updated_user_fields:
        user.save(update_fields=list(dict.fromkeys(updated_user_fields)))
    if updated_profile_fields:
        profile.save(update_fields=list(dict.fromkeys(updated_profile_fields + ["updated_at"])))
    if update_login or update_password or update_profile_data or uploaded_avatar is not None or remove_avatar:
        _create_user_notification(
            user_id=target_user_id,
            kind=UserNotification.KIND_ACCOUNT,
            title="Профиль обновлён",
            body="Администратор обновил данные вашего аккаунта.",
            link_url="/profile-settings",
        )

    online_after = dj_timezone.now() - timedelta(minutes=ONLINE_WINDOW_MINUTES)
    return JsonResponse(_serialize_admin_user(user, online_after=online_after))


@csrf_exempt
def admin_reset_user_password(request: HttpRequest, target_user_id: int) -> JsonResponse:
    user_id, _ = _extract_auth_user(request)
    _, _, telegram_id, _, _, _, _ = _extract_auth_identity(request)
    if user_id is None:
        return JsonResponse({"error": "Unauthorized"}, status=401)
    if not _is_admin_identity(user_id, telegram_id):
        return JsonResponse({"error": "Forbidden"}, status=403)
    if request.method != "POST":
        return JsonResponse({"error": "Invalid method"}, status=405)

    try:
        user = User.objects.get(id=target_user_id)
    except User.DoesNotExist:
        return JsonResponse({"error": "User not found"}, status=404)

    user.set_unusable_password()
    user.save(update_fields=["password"])
    _create_user_notification(
        user_id=target_user_id,
        kind=UserNotification.KIND_ACCOUNT,
        title="Пароль сброшен",
        body="Администратор сбросил пароль. Для входа потребуется повторная регистрация.",
        link_url="/auth",
    )

    online_after = dj_timezone.now() - timedelta(minutes=ONLINE_WINDOW_MINUTES)
    payload = _serialize_admin_user(user, online_after=online_after)
    payload["re_register_required"] = True
    return JsonResponse(payload)


@csrf_exempt
def admin_update_payment_proof(request: HttpRequest, proof_id: int) -> JsonResponse | HttpResponse:
    user_id, username = _extract_auth_user(request)
    _, _, telegram_id, _, _, _, _ = _extract_auth_identity(request)
    if user_id is None:
        return JsonResponse({"error": "Unauthorized"}, status=401)
    if not _is_admin_identity(user_id, telegram_id):
        return JsonResponse({"error": "Forbidden"}, status=403)

    if request.method == "DELETE":
        try:
            proof = PaymentProof.objects.get(id=proof_id)
        except PaymentProof.DoesNotExist:
            return JsonResponse({"error": "Not found"}, status=404)

        # Удаляем файл из хранилища и запись из базы.
        proof.file.delete(save=False)
        proof.delete()
        return HttpResponse(status=204)

    if request.method != "PATCH":
        return JsonResponse({"error": "Invalid method"}, status=405)

    try:
        payload = json.loads(request.body)
    except json.JSONDecodeError:
        return JsonResponse({"error": "Invalid JSON"}, status=400)

    status = payload.get("status", "")
    if status not in {
        PaymentProof.STATUS_PENDING,
        PaymentProof.STATUS_APPROVED,
        PaymentProof.STATUS_REJECTED,
    }:
        return JsonResponse({"error": "Invalid status"}, status=400)

    try:
        proof = PaymentProof.objects.get(id=proof_id)
    except PaymentProof.DoesNotExist:
        return JsonResponse({"error": "Not found"}, status=404)

    proof.status = status
    proof.reviewed_at = datetime.now(timezone.utc)
    proof.reviewed_by = user_id
    proof.reviewed_by_username = username
    proof.save(update_fields=["status", "reviewed_at", "reviewed_by", "reviewed_by_username"])
    if status == PaymentProof.STATUS_APPROVED:
        title = "Оплата подтверждена"
        body = "Администратор подтвердил вашу отправку оплаты."
    elif status == PaymentProof.STATUS_REJECTED:
        title = "Оплата отклонена"
        body = "Администратор отклонил отправленное фото оплаты."
    else:
        title = "Оплата снова на проверке"
        body = "Статус вашей отправки оплаты изменён на ожидание."
    _create_user_notification(
        user_id=proof.user_id,
        kind=UserNotification.KIND_PAYMENT,
        title=title,
        body=body,
        link_url="/profile-pay",
    )

    data = _serialize_proof(proof)
    data["file_url"] = f"/api/payment-proofs/{proof.id}/file/"
    return JsonResponse(data)
