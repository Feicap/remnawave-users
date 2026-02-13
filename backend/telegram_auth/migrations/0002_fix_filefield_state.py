from django.db import migrations, models

import telegram_auth.models


class Migration(migrations.Migration):
    dependencies = [
        ("telegram_auth", "0001_initial"),
    ]

    operations = [
        migrations.AlterField(
            model_name="paymentproof",
            name="file",
            field=models.FileField(upload_to=telegram_auth.models.payment_proof_upload_path),
        ),
    ]
