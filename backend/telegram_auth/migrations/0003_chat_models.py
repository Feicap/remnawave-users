from django.db import migrations, models
import django.utils.timezone


class Migration(migrations.Migration):
    dependencies = [
        ("telegram_auth", "0002_fix_filefield_state"),
    ]

    operations = [
        migrations.CreateModel(
            name="ChatMessage",
            fields=[
                ("id", models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name="ID")),
                ("scope", models.CharField(choices=[("global", "Global"), ("private", "Private")], db_index=True, max_length=16)),
                ("sender_id", models.BigIntegerField(db_index=True)),
                ("sender_username", models.CharField(blank=True, default="", max_length=255)),
                ("recipient_id", models.BigIntegerField(blank=True, db_index=True, null=True)),
                ("recipient_username", models.CharField(blank=True, default="", max_length=255)),
                ("body", models.TextField()),
                ("created_at", models.DateTimeField(auto_now_add=True, db_index=True)),
            ],
            options={
                "indexes": [
                    models.Index(fields=["scope", "created_at"], name="telegram_aut_scope_962f35_idx"),
                    models.Index(fields=["recipient_id", "created_at"], name="telegram_aut_recipie_95f58f_idx"),
                    models.Index(fields=["sender_id", "created_at"], name="telegram_aut_sender__b3fc2f_idx"),
                ],
            },
        ),
        migrations.CreateModel(
            name="ChatReadMarker",
            fields=[
                ("id", models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name="ID")),
                ("user_id", models.BigIntegerField(db_index=True)),
                ("scope", models.CharField(choices=[("global", "Global"), ("private", "Private")], db_index=True, max_length=16)),
                ("peer_id", models.BigIntegerField(db_index=True, default=0)),
                ("last_read_at", models.DateTimeField(default=django.utils.timezone.now)),
            ],
            options={
                "indexes": [models.Index(fields=["user_id", "scope", "peer_id"], name="telegram_aut_user_id_02fc8e_idx")],
                "constraints": [
                    models.UniqueConstraint(fields=("user_id", "scope", "peer_id"), name="unique_chat_read_marker")
                ],
            },
        ),
        migrations.CreateModel(
            name="ChatUserProfile",
            fields=[
                ("id", models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name="ID")),
                ("user_id", models.BigIntegerField(db_index=True, unique=True)),
                ("username", models.CharField(blank=True, default="", max_length=255)),
                ("email", models.CharField(blank=True, default="", max_length=255)),
                ("telegram_username", models.CharField(blank=True, default="", max_length=255)),
                ("photo", models.CharField(blank=True, default="", max_length=2048)),
                ("auth_provider", models.CharField(blank=True, default="", max_length=32)),
                ("created_at", models.DateTimeField(auto_now_add=True, db_index=True)),
                ("updated_at", models.DateTimeField(auto_now=True, db_index=True)),
            ],
        ),
    ]
