from django.db import models


def payment_proof_upload_path(instance: "PaymentProof", filename: str) -> str:
    return f"payment_proofs/{instance.user_id}/{filename}"


class PaymentProof(models.Model):
    STATUS_PENDING = "pending"
    STATUS_APPROVED = "approved"
    STATUS_REJECTED = "rejected"
    STATUS_CHOICES = (
        (STATUS_PENDING, "Pending"),
        (STATUS_APPROVED, "Approved"),
        (STATUS_REJECTED, "Rejected"),
    )

    user_id = models.BigIntegerField(db_index=True)
    username = models.CharField(max_length=255, blank=True, default="")
    file = models.FileField(upload_to=payment_proof_upload_path)
    status = models.CharField(max_length=16, choices=STATUS_CHOICES, default=STATUS_PENDING, db_index=True)
    created_at = models.DateTimeField(auto_now_add=True, db_index=True)
    reviewed_at = models.DateTimeField(null=True, blank=True)
    reviewed_by = models.BigIntegerField(null=True, blank=True)
    reviewed_by_username = models.CharField(max_length=255, blank=True, default="")

    def __str__(self) -> str:
        return f"{self.user_id} - {self.status} - {self.created_at.isoformat()}"
