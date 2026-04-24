from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [
        ("telegram_auth", "0008_chatuserprofile_avatar_presentation"),
    ]

    operations = [
        migrations.CreateModel(
            name="UserNotification",
            fields=[
                ("id", models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name="ID")),
                ("user_id", models.BigIntegerField(db_index=True)),
                (
                    "kind",
                    models.CharField(
                        choices=[
                            ("payment", "Payment"),
                            ("chat", "Chat"),
                            ("account", "Account"),
                            ("system", "System"),
                        ],
                        db_index=True,
                        default="system",
                        max_length=24,
                    ),
                ),
                ("title", models.CharField(max_length=255)),
                ("body", models.TextField(blank=True, default="")),
                ("link_url", models.CharField(blank=True, default="", max_length=2048)),
                ("is_read", models.BooleanField(db_index=True, default=False)),
                ("created_at", models.DateTimeField(auto_now_add=True, db_index=True)),
                ("read_at", models.DateTimeField(blank=True, null=True)),
            ],
            options={
                "indexes": [models.Index(fields=["user_id", "is_read", "created_at"], name="telegram_au_user_id_7241ac_idx")],
            },
        ),
    ]
