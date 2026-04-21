from django.db import migrations, models

import telegram_auth.models


class Migration(migrations.Migration):
    dependencies = [
        ("telegram_auth", "0004_chat_message_lifecycle"),
    ]

    operations = [
        migrations.AddField(
            model_name="chatuserprofile",
            name="avatar_file",
            field=models.FileField(blank=True, null=True, upload_to=telegram_auth.models.chat_avatar_upload_path),
        ),
        migrations.AddField(
            model_name="chatuserprofile",
            name="display_name",
            field=models.CharField(blank=True, default="", max_length=255),
        ),
    ]
