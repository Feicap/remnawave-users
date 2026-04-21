from django.urls import path

from .views import (
    admin_payment_proof_users,
    admin_payment_proofs,
    admin_reset_user_password,
    admin_update_payment_proof,
    admin_update_user_credentials,
    admin_users,
    auth_me,
    email_check,
    email_login,
    email_register,
    health_check,
    payment_proof_file,
    payment_proofs_collection,
    telegram_avatar,
    telegram_login,
)

urlpatterns = [
    path("health/", health_check, name="health_check"),
    path("auth/me/", auth_me, name="auth_me"),
    path("auth/email/check/", email_check, name="email_check"),
    path("auth/email/login/", email_login, name="email_login"),
    path("auth/email/register/", email_register, name="email_register"),
    path("auth/telegram-avatar/<int:telegram_id>/", telegram_avatar, name="telegram_avatar"),
    path("auth/telegram/", telegram_login, name="telegram_login"),
    path("payment-proofs/", payment_proofs_collection, name="payment_proofs_collection"),
    path("payment-proofs/<int:proof_id>/file/", payment_proof_file, name="payment_proof_file"),
    path("admin/payment-proofs/users/", admin_payment_proof_users, name="admin_payment_proof_users"),
    path("admin/payment-proofs/", admin_payment_proofs, name="admin_payment_proofs"),
    path("admin/payment-proofs/<int:proof_id>/", admin_update_payment_proof, name="admin_update_payment_proof"),
    path("admin/users/", admin_users, name="admin_users"),
    path("admin/users/<int:target_user_id>/", admin_update_user_credentials, name="admin_update_user_credentials"),
    path("admin/users/<int:target_user_id>/reset-password/", admin_reset_user_password, name="admin_reset_user_password"),
]
