from django.db import migrations, models
from django.db.models import Q
import django.db.models.deletion


class Migration(migrations.Migration):
    dependencies = [
        ("telegram_auth", "0003_chat_models"),
    ]

    operations = [
        migrations.AddField(
            model_name="chatmessage",
            name="client_message_id",
            field=models.CharField(blank=True, db_index=True, default="", max_length=64),
        ),
        migrations.AddField(
            model_name="chatmessage",
            name="deleted_at",
            field=models.DateTimeField(blank=True, null=True),
        ),
        migrations.AddField(
            model_name="chatmessage",
            name="deleted_by_admin",
            field=models.BooleanField(default=False),
        ),
        migrations.AddField(
            model_name="chatmessage",
            name="deleted_by_user_id",
            field=models.BigIntegerField(blank=True, null=True),
        ),
        migrations.AddField(
            model_name="chatmessage",
            name="edited_at",
            field=models.DateTimeField(blank=True, db_index=True, null=True),
        ),
        migrations.AddField(
            model_name="chatmessage",
            name="is_deleted",
            field=models.BooleanField(db_index=True, default=False),
        ),
        migrations.AddConstraint(
            model_name="chatmessage",
            constraint=models.UniqueConstraint(
                condition=~Q(client_message_id=""),
                fields=("sender_id", "client_message_id"),
                name="unique_sender_client_message",
            ),
        ),
        migrations.CreateModel(
            name="ChatModerationAction",
            fields=[
                ("id", models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name="ID")),
                ("action", models.CharField(choices=[("edit", "Edit"), ("delete", "Delete")], db_index=True, max_length=16)),
                ("acted_by_user_id", models.BigIntegerField(db_index=True)),
                ("acted_by_username", models.CharField(blank=True, default="", max_length=255)),
                ("is_admin_action", models.BooleanField(db_index=True, default=False)),
                ("previous_body", models.TextField(blank=True, default="")),
                ("next_body", models.TextField(blank=True, default="")),
                ("created_at", models.DateTimeField(auto_now_add=True, db_index=True)),
                (
                    "message",
                    models.ForeignKey(
                        on_delete=django.db.models.deletion.CASCADE,
                        related_name="moderation_actions",
                        to="telegram_auth.chatmessage",
                    ),
                ),
            ],
        ),
    ]
