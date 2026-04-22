from django.db import migrations, models, transaction


def _normalize_email(value: str) -> str:
    return (value or "").strip().lower()


def seed_auth_identities(apps, schema_editor):
    User = apps.get_model("auth", "User")
    ChatUserProfile = apps.get_model("telegram_auth", "ChatUserProfile")
    AuthIdentity = apps.get_model("telegram_auth", "AuthIdentity")

    with transaction.atomic():
        for user in User.objects.all().only("id", "username", "email"):
            email = _normalize_email(user.email or "")
            if not email:
                username = _normalize_email(user.username or "")
                if "@" in username:
                    email = username
            if not email:
                continue

            AuthIdentity.objects.get_or_create(
                provider="email",
                provider_user_id=email,
                defaults={"user_id": user.id},
            )

        for profile in ChatUserProfile.objects.exclude(telegram_id__isnull=True).only("user_id", "telegram_id"):
            if not User.objects.filter(id=profile.user_id).exists():
                continue
            AuthIdentity.objects.get_or_create(
                provider="telegram",
                provider_user_id=str(profile.telegram_id),
                defaults={"user_id": profile.user_id},
            )


class Migration(migrations.Migration):
    dependencies = [
        ("telegram_auth", "0006_chat_user_profile_telegram_id"),
    ]

    operations = [
        migrations.CreateModel(
            name="AuthIdentity",
            fields=[
                ("id", models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name="ID")),
                ("provider", models.CharField(choices=[("email", "Email"), ("telegram", "Telegram")], db_index=True, max_length=16)),
                ("provider_user_id", models.CharField(db_index=True, max_length=255)),
                ("created_at", models.DateTimeField(auto_now_add=True, db_index=True)),
                ("updated_at", models.DateTimeField(auto_now=True, db_index=True)),
                (
                    "user",
                    models.ForeignKey(on_delete=models.deletion.CASCADE, related_name="auth_identities", to="auth.user"),
                ),
            ],
            options={
                "indexes": [models.Index(fields=["user", "provider"], name="telegram_aut_user_id_68e1eb_idx")],
                "constraints": [
                    models.UniqueConstraint(fields=("provider", "provider_user_id"), name="uniq_auth_identity_provider_key"),
                    models.UniqueConstraint(fields=("user", "provider"), name="uniq_auth_identity_user_provider"),
                ],
            },
        ),
        migrations.RunPython(seed_auth_identities, migrations.RunPython.noop),
    ]
