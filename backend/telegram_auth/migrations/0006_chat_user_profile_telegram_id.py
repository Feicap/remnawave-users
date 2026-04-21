from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ("telegram_auth", "0005_chat_user_profile_settings"),
    ]

    operations = [
        migrations.AddField(
            model_name="chatuserprofile",
            name="telegram_id",
            field=models.BigIntegerField(blank=True, db_index=True, null=True, unique=True),
        ),
    ]
