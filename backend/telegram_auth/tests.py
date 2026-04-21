import os
from unittest.mock import patch

from django.test import TestCase

from telegram_auth import views


def _auth_headers(user_id: int, username: str, email: str = "") -> dict:
    return {
        "HTTP_X_TELEGRAM_USER_ID": str(user_id),
        "HTTP_X_TELEGRAM_USERNAME": username,
        "HTTP_X_AUTH_USER_ID": str(user_id),
        "HTTP_X_AUTH_USERNAME": username,
        "HTTP_X_AUTH_EMAIL": email,
        "HTTP_X_AUTH_PROVIDER": "email",
    }


class ChatApiTests(TestCase):
    @patch.dict(os.environ, {"ADMIN": "999"}, clear=False)
    def test_private_access_and_admin_visibility(self):
        sender_headers = _auth_headers(101, "alice", "alice@example.com")
        recipient_headers = _auth_headers(202, "bob", "bob@example.com")
        outsider_headers = _auth_headers(303, "carol", "carol@example.com")
        admin_headers = _auth_headers(999, "admin", "admin@example.com")

        send_response = self.client.post(
            "/api/chat/messages/",
            data={"scope": "private", "recipient_id": 202, "body": "secret text"},
            content_type="application/json",
            **sender_headers,
        )
        self.assertEqual(send_response.status_code, 201)

        recipient_response = self.client.get("/api/chat/messages/?scope=private&peer_id=101", **recipient_headers)
        self.assertEqual(recipient_response.status_code, 200)
        recipient_items = recipient_response.json()["items"]
        self.assertEqual(len(recipient_items), 1)
        self.assertEqual(recipient_items[0]["body"], "secret text")

        outsider_response = self.client.get("/api/chat/messages/?scope=private&peer_id=101", **outsider_headers)
        self.assertEqual(outsider_response.status_code, 200)
        self.assertEqual(len(outsider_response.json()["items"]), 0)

        admin_response = self.client.get("/api/admin/chat/messages/?scope=private", **admin_headers)
        self.assertEqual(admin_response.status_code, 200)
        admin_items = admin_response.json()["items"]
        self.assertEqual(len(admin_items), 1)
        self.assertEqual(admin_items[0]["body"], "secret text")

    def test_idempotency_and_rate_limit(self):
        old_limit = views.CHAT_RATE_LIMIT_MAX_MESSAGES
        old_window = views.CHAT_RATE_LIMIT_WINDOW_SECONDS
        views.CHAT_RATE_LIMIT_MAX_MESSAGES = 2
        views.CHAT_RATE_LIMIT_WINDOW_SECONDS = 60
        self.addCleanup(setattr, views, "CHAT_RATE_LIMIT_MAX_MESSAGES", old_limit)
        self.addCleanup(setattr, views, "CHAT_RATE_LIMIT_WINDOW_SECONDS", old_window)

        headers = _auth_headers(111, "sender", "sender@example.com")

        first = self.client.post(
            "/api/chat/messages/",
            data={"scope": "global", "body": "hello", "client_message_id": "dup-1"},
            content_type="application/json",
            **headers,
        )
        self.assertEqual(first.status_code, 201)
        first_id = first.json()["id"]

        duplicate = self.client.post(
            "/api/chat/messages/",
            data={"scope": "global", "body": "hello", "client_message_id": "dup-1"},
            content_type="application/json",
            **headers,
        )
        self.assertEqual(duplicate.status_code, 200)
        self.assertEqual(duplicate.json()["id"], first_id)

        second = self.client.post(
            "/api/chat/messages/",
            data={"scope": "global", "body": "second"},
            content_type="application/json",
            **headers,
        )
        self.assertEqual(second.status_code, 201)

        blocked = self.client.post(
            "/api/chat/messages/",
            data={"scope": "global", "body": "third"},
            content_type="application/json",
            **headers,
        )
        self.assertEqual(blocked.status_code, 429)
        self.assertIn("Too many messages", blocked.json()["error"])

    @patch.dict(os.environ, {"ADMIN": "909"}, clear=False)
    def test_edit_delete_permissions_and_moderation_audit(self):
        sender_headers = _auth_headers(121, "writer", "writer@example.com")
        recipient_headers = _auth_headers(232, "reader", "reader@example.com")
        admin_headers = _auth_headers(909, "admin", "admin@example.com")

        message_response = self.client.post(
            "/api/chat/messages/",
            data={"scope": "private", "recipient_id": 232, "body": "original body"},
            content_type="application/json",
            **sender_headers,
        )
        self.assertEqual(message_response.status_code, 201)
        message_id = message_response.json()["id"]

        forbidden_edit = self.client.patch(
            f"/api/chat/messages/{message_id}/",
            data={"body": "hacked"},
            content_type="application/json",
            **recipient_headers,
        )
        self.assertEqual(forbidden_edit.status_code, 403)

        own_edit = self.client.patch(
            f"/api/chat/messages/{message_id}/",
            data={"body": "edited body"},
            content_type="application/json",
            **sender_headers,
        )
        self.assertEqual(own_edit.status_code, 200)
        self.assertEqual(own_edit.json()["body"], "edited body")
        self.assertIsNotNone(own_edit.json()["edited_at"])

        own_delete = self.client.delete(f"/api/chat/messages/{message_id}/", **sender_headers)
        self.assertEqual(own_delete.status_code, 200)
        self.assertTrue(own_delete.json()["is_deleted"])

        audit_response = self.client.get("/api/admin/chat/actions/?limit=20", **admin_headers)
        self.assertEqual(audit_response.status_code, 200)
        audit_items = audit_response.json()["items"]
        actions = [item["action"] for item in audit_items]
        self.assertIn("edit", actions)
        self.assertIn("delete", actions)

        admin_message = self.client.post(
            "/api/chat/messages/",
            data={"scope": "private", "recipient_id": 232, "body": "admin target"},
            content_type="application/json",
            **sender_headers,
        )
        self.assertEqual(admin_message.status_code, 201)
        admin_target_id = admin_message.json()["id"]

        admin_delete = self.client.delete(f"/api/chat/messages/{admin_target_id}/", **admin_headers)
        self.assertEqual(admin_delete.status_code, 200)

        audit_response_after_admin = self.client.get("/api/admin/chat/actions/?limit=20", **admin_headers)
        self.assertEqual(audit_response_after_admin.status_code, 200)
        admin_actions = [item for item in audit_response_after_admin.json()["items"] if item["action"] == "delete"]
        self.assertTrue(any(item["is_admin_action"] for item in admin_actions))

    def test_pagination_and_search(self):
        sender_headers = _auth_headers(431, "bulk", "bulk@example.com")
        reader_headers = _auth_headers(542, "reader", "reader@example.com")

        for index in range(5):
            response = self.client.post(
                "/api/chat/messages/",
                data={"scope": "global", "body": f"message {index}"},
                content_type="application/json",
                **sender_headers,
            )
            self.assertEqual(response.status_code, 201)

        first_page = self.client.get("/api/chat/messages/?scope=global&limit=2", **reader_headers)
        self.assertEqual(first_page.status_code, 200)
        first_payload = first_page.json()
        self.assertEqual(len(first_payload["items"]), 2)
        self.assertTrue(first_payload["pagination"]["has_more"])

        before_id = first_payload["pagination"]["next_before_id"]
        second_page = self.client.get(f"/api/chat/messages/?scope=global&limit=2&before_id={before_id}", **reader_headers)
        self.assertEqual(second_page.status_code, 200)
        second_payload = second_page.json()
        self.assertEqual(len(second_payload["items"]), 2)

        search_response = self.client.get("/api/chat/messages/?scope=global&q=message 4", **reader_headers)
        self.assertEqual(search_response.status_code, 200)
        search_items = search_response.json()["items"]
        self.assertEqual(len(search_items), 1)
        self.assertEqual(search_items[0]["body"], "message 4")
