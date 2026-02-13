import json
import mimetypes
import os
from datetime import datetime, timezone
from pathlib import Path
from time import time

from django.http import FileResponse, HttpRequest, JsonResponse
from django.db.models import Count, Max, Q
from django.views.decorators.csrf import csrf_exempt

from .models import PaymentProof
from .remnawave_client import get_subscription_url_sync
from .services import has_telegram_config, is_user_in_group, verify_telegram_auth

ALLOWED_IMAGE_EXTENSIONS = {".jpg", ".jpeg", ".png", ".webp", ".bmp", ".heic", ".svg"}
MAX_FILE_SIZE_BYTES = 10 * 1024 * 1024


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


def _is_admin(user_id: int) -> bool:
    return user_id in _parse_admin_ids()


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

    if not is_user_in_group(user["id"]):
        return JsonResponse({"error": "User not in Telegram group"}, status=403)

    subscription_url = get_subscription_url_sync(user["id"]) or "no response"
    return JsonResponse(
        {
            "id": user["id"],
            "username": user.get("username"),
            "photo": user.get("photo_url"),
            "subscription_url": subscription_url,
            "token": "FAKE_JWT",
        }
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
    if user_id is None:
        return JsonResponse({"error": "Unauthorized"}, status=401)

    try:
        proof = PaymentProof.objects.get(id=proof_id)
    except PaymentProof.DoesNotExist:
        return JsonResponse({"error": "Not found"}, status=404)

    if proof.user_id != user_id and not _is_admin(user_id):
        return JsonResponse({"error": "Forbidden"}, status=403)

    content_type, _ = mimetypes.guess_type(proof.file.name)
    content_type = content_type or "application/octet-stream"
    return FileResponse(proof.file.open("rb"), content_type=content_type)


def admin_payment_proof_users(request: HttpRequest) -> JsonResponse:
    user_id, _ = _extract_auth_user(request)
    if user_id is None:
        return JsonResponse({"error": "Unauthorized"}, status=401)
    if not _is_admin(user_id):
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
    if user_id is None:
        return JsonResponse({"error": "Unauthorized"}, status=401)
    if not _is_admin(user_id):
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
def admin_update_payment_proof(request: HttpRequest, proof_id: int) -> JsonResponse:
    user_id, username = _extract_auth_user(request)
    if user_id is None:
        return JsonResponse({"error": "Unauthorized"}, status=401)
    if not _is_admin(user_id):
        return JsonResponse({"error": "Forbidden"}, status=403)
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
