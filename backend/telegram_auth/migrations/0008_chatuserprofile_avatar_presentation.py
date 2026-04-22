from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [
        ("telegram_auth", "0007_auth_identity"),
    ]

    operations = [
        migrations.AddField(
            model_name="chatuserprofile",
            name="avatar_position_x",
            field=models.PositiveSmallIntegerField(default=50),
        ),
        migrations.AddField(
            model_name="chatuserprofile",
            name="avatar_position_y",
            field=models.PositiveSmallIntegerField(default=50),
        ),
        migrations.AddField(
            model_name="chatuserprofile",
            name="avatar_scale",
            field=models.FloatField(default=1.0),
        ),
    ]
