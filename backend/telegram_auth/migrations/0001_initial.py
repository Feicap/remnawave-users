from django.db import migrations, models


def payment_proof_upload_path(instance, filename):
    return f"payment_proofs/{instance.user_id}/{filename}"


class Migration(migrations.Migration):
    initial = True

    dependencies = []

    operations = [
        migrations.CreateModel(
            name="PaymentProof",
            fields=[
                ("id", models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name="ID")),
                ("user_id", models.BigIntegerField(db_index=True)),
                ("username", models.CharField(blank=True, default="", max_length=255)),
                ("file", models.FileField(upload_to=payment_proof_upload_path)),
                (
                    "status",
                    models.CharField(
                        choices=[("pending", "Pending"), ("approved", "Approved"), ("rejected", "Rejected")],
                        db_index=True,
                        default="pending",
                        max_length=16,
                    ),
                ),
                ("created_at", models.DateTimeField(auto_now_add=True, db_index=True)),
                ("reviewed_at", models.DateTimeField(blank=True, null=True)),
                ("reviewed_by", models.BigIntegerField(blank=True, null=True)),
                ("reviewed_by_username", models.CharField(blank=True, default="", max_length=255)),
            ],
        ),
    ]
