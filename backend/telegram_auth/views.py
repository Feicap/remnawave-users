import json
import mimetypes
import os
from datetime import datetime, timezone
from pathlib import Path
from time import time

from django.contrib.auth.models import User
from django.core.exceptions import ValidationError
from django.core.validators import validate_email
from django.http import FileResponse, HttpRequest, HttpResponse, JsonResponse
from django.db.models import Count, Max, Q
from django.views.decorators.csrf import csrf_exempt

from .models import PaymentProof
from .remnawave_client import get_remnawave_user_sync
from .services import has_telegram_config, verify_telegram_auth

ALLOWED_IMAGE_EXTENSIONS = {".jpg", ".jpeg", ".png", ".webp", ".bmp", ".heic", ".svg"}
MAX_FILE_SIZE_BYTES = 10 * 1024 * 1024


def _normalize_email(value: str) -> str:
    return value.strip().lower()


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
    return User.objects.filter(Q(email__iexact=email) | Q(username__iexact=email)).first()


def _parse_optional_int(value: str) -> int | None:
    cleaned = value.strip()
    if not cleaned:
        return None
    if cleaned.startswith("-"):
        cleaned = cleaned[1:]
    if not cleaned.isdigit():
        return None
    return int(value.strip())


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

    resolved_email = remnawave_user.get("email") or email
    resolved_telegram_id = remnawave_user.get("telegram_id") or telegram_id
    resolved_telegram_username = remnawave_user.get("telegram_username") or telegram_username
    resolved_photo = remnawave_user.get("photo") or photo
    resolved_subscription_url = remnawave_user.get("subscription_url") or subscription_url

    display_username = resolved_telegram_username or resolved_email or username or ""

    payload = {
        "id": user_id,
        "username": display_username,
        "photo": resolved_photo or "",
        "token": "FAKE_JWT",
        "auth_provider": auth_provider,
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


def _extract_auth_user(request: HttpRequest) -> tuple[int | None, str]:
    header_user_id = request.headers.get("X-Telegram-User-Id", "").strip()
    header_username = request.headers.get("X-Telegram-Username", "").strip()
    if not header_user_id.isdigit():
        return None, header_username
    return int(header_user_id), header_username


def _extract_auth_identity(request: HttpRequest) -> tuple[int | None, str | None, int | None, str, str, str, str]:
    user_id = _parse_optional_int(request.headers.get("X-Auth-User-Id", "")) or _parse_optional_int(
        request.headers.get("X-Telegram-User-Id", "")
    )
    email = _normalize_email(request.headers.get("X-Auth-Email", "")) or None
    telegram_id = _parse_optional_int(request.headers.get("X-Auth-Telegram-Id", ""))
    username = request.headers.get("X-Auth-Username", "").strip() or request.headers.get("X-Telegram-Username", "").strip()
    telegram_username = request.headers.get("X-Auth-Telegram-Username", "").strip()
    photo = request.headers.get("X-Auth-Photo", "").strip()
    auth_provider = request.headers.get("X-Auth-Provider", "").strip()
    return user_id, email, telegram_id, username, telegram_username, photo, auth_provider


def _is_admin(user_id: int) -> bool:
    return user_id in _parse_admin_ids()


def _is_admin_identity(user_id: int | None, telegram_id: int | None = None) -> bool:
    if user_id is not None and _is_admin(user_id):
        return True
    return telegram_id is not None and _is_admin(telegram_id)


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


@csrf_exempt
def telegram_login(request: HttpRequest) -> JsonResponse:
    if request.method != "POST":
        return JsonResponse({"error": "Invalid method"}, status=405)

    try:
        user = json.loads(request.body)
    except json.JSONDecodeError:
        return JsonResponse({"error": "Invalid JSON"}, status=400)

    if not has_telegram_config():
        return JsonResponse({"error": "Server Telegram config missing"}, status=500)

    if not verify_telegram_auth(user):
        return JsonResponse({"error": "Invalid Telegram auth"}, status=403)

    if time() - int(user.get("auth_date", 0)) > 86400:
        return JsonResponse({"error": "Auth expired"}, status=403)

    remnawave_user = get_remnawave_user_sync(telegram_id=user["id"])
    return _build_auth_response(
        user_id=user["id"],
        username=user.get("username") or "",
        photo=user.get("photo_url") or "",
        telegram_id=user["id"],
        telegram_username=user.get("username") or None,
        auth_provider="telegram",
        remnawave_user=remnawave_user,
    )


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

    if _find_user_by_email(email) is not None:
        return JsonResponse({"error": "Email already exists"}, status=409)

    user = User.objects.create_user(
        username=email,
        email=email,
        password=password,
    )
    remnawave_user = get_remnawave_user_sync(email=email)
    return _build_auth_response(
        user_id=user.id,
        username=user.email or user.username,
        email=user.email or user.username,
        auth_provider="email",
        remnawave_user=remnawave_user,
    )


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

    remnawave_user = get_remnawave_user_sync(email=email)
    return _build_auth_response(
        user_id=user.id,
        username=user.email or user.username,
        email=user.email or user.username,
        auth_provider="email",
        remnawave_user=remnawave_user,
    )


def auth_me(request: HttpRequest) -> JsonResponse:
    if request.method != "GET":
        return JsonResponse({"error": "Invalid method"}, status=405)

    user_id, email, telegram_id, username, telegram_username, photo, auth_provider = _extract_auth_identity(request)
    if user_id is None:
        return JsonResponse({"error": "Unauthorized"}, status=401)

    remnawave_user = None
    if email:
        remnawave_user = get_remnawave_user_sync(email=email)
    elif telegram_id is not None:
        remnawave_user = get_remnawave_user_sync(telegram_id=telegram_id)

    return _build_auth_response(
        user_id=user_id,
        username=username,
        photo=photo,
        email=email,
        telegram_id=telegram_id,
        telegram_username=telegram_username or (username if auth_provider == "telegram" else None),
        auth_provider=auth_provider or ("telegram" if telegram_id is not None and not email else "email"),
        remnawave_user=remnawave_user,
    )


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

    data = _serialize_proof(proof)
    data["file_url"] = f"/api/payment-proofs/{proof.id}/file/"
    return JsonResponse(data)
