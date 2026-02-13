from django.urls import path

from .views import (
    admin_payment_proof_users,
    admin_payment_proofs,
    admin_update_payment_proof,
    health_check,
    payment_proof_file,
    payment_proofs_collection,
    telegram_login,
)

urlpatterns = [
    path("health/", health_check, name="health_check"),
    path("auth/telegram/", telegram_login, name="telegram_login"),
    path("payment-proofs/", payment_proofs_collection, name="payment_proofs_collection"),
    path("payment-proofs/<int:proof_id>/file/", payment_proof_file, name="payment_proof_file"),
    path("admin/payment-proofs/users/", admin_payment_proof_users, name="admin_payment_proof_users"),
    path("admin/payment-proofs/", admin_payment_proofs, name="admin_payment_proofs"),
    path("admin/payment-proofs/<int:proof_id>/", admin_update_payment_proof, name="admin_update_payment_proof"),
]
