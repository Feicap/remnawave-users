import os
from unittest.mock import patch

from django.contrib.auth.models import User
from django.core.files.uploadedfile import SimpleUploadedFile
from django.test import TestCase

from telegram_auth.models import AuthIdentity, ChatMessage, ChatUserProfile
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

    def test_chat_messages_use_current_profile_display_name(self):
        sender_headers = _auth_headers(515, "oldnick", "oldnick@example.com")
        reader_headers = _auth_headers(616, "reader", "reader@example.com")

        send_response = self.client.post(
            "/api/chat/messages/",
            data={"scope": "global", "body": "before rename"},
            content_type="application/json",
            **sender_headers,
        )
        self.assertEqual(send_response.status_code, 201)
        self.assertEqual(send_response.json()["sender_username"], "oldnick")

        profile_response = self.client.patch(
            "/api/profile/settings/",
            data={"display_name": "FreshNick"},
            content_type="application/json",
            **sender_headers,
        )
        self.assertEqual(profile_response.status_code, 200)
        self.assertEqual(profile_response.json()["display_name"], "FreshNick")

        stored_message = ChatMessage.objects.get(id=send_response.json()["id"])
        self.assertEqual(stored_message.sender_username, "oldnick")

        messages_response = self.client.get("/api/chat/messages/?scope=global", **reader_headers)
        self.assertEqual(messages_response.status_code, 200)
        items = messages_response.json()["items"]
        self.assertEqual(len(items), 1)
        self.assertEqual(items[0]["sender_username"], "FreshNick")


class AuthIdentityBindingTests(TestCase):
    @patch("telegram_auth.views._resolve_remnawave_user")
    @patch("telegram_auth.views.verify_telegram_auth", return_value=True)
    @patch("telegram_auth.views.has_telegram_config", return_value=True)
    def test_telegram_login_uses_existing_email_account(
        self,
        _has_telegram_config,
        _verify_telegram_auth,
        mock_resolve_remnawave,
    ):
        user = User.objects.create_user(username="bind@example.com", email="bind@example.com", password="secret123")
        mock_resolve_remnawave.return_value = {
            "email": "bind@example.com",
            "telegram_id": 555001,
            "telegram_username": "bind_user",
        }

        response = self.client.post(
            "/api/auth/telegram/",
            data={"id": 555001, "username": "bind_user", "auth_date": str(int(views.time()))},
            content_type="application/json",
        )

        self.assertEqual(response.status_code, 200)
        payload = response.json()
        self.assertEqual(payload["id"], user.id)
        self.assertEqual(payload["telegram_id"], 555001)

        profile = ChatUserProfile.objects.get(user_id=user.id)
        self.assertEqual(profile.telegram_id, 555001)
        self.assertEqual(profile.email, "bind@example.com")

    def test_profile_settings_with_email_and_telegram_headers_updates_single_profile(self):
        user = User.objects.create_user(username="single@example.com", email="single@example.com", password="secret123")

        stale_profile = ChatUserProfile.objects.create(
            user_id=777001,
            telegram_id=777001,
            username="legacy",
            email="",
            auth_provider="telegram",
        )
        self.assertEqual(stale_profile.telegram_id, 777001)

        headers = {
            "HTTP_X_AUTH_USER_ID": "777001",
            "HTTP_X_AUTH_USERNAME": "legacy_user",
            "HTTP_X_AUTH_EMAIL": "single@example.com",
            "HTTP_X_AUTH_TELEGRAM_ID": "777001",
            "HTTP_X_AUTH_TELEGRAM_USERNAME": "legacy_user",
            "HTTP_X_AUTH_PROVIDER": "telegram",
            "HTTP_X_TELEGRAM_USER_ID": "777001",
            "HTTP_X_TELEGRAM_USERNAME": "legacy_user",
        }
        avatar = SimpleUploadedFile("avatar.png", b"fakepngcontent", content_type="image/png")
        response = self.client.patch(
            "/api/profile/settings/",
            data={"display_name": "zzz", "avatar": avatar},
            **headers,
        )
        self.assertEqual(response.status_code, 200)
        payload = response.json()
        self.assertEqual(payload["id"], user.id)
        self.assertEqual(payload["display_name"], "zzz")

        profile = ChatUserProfile.objects.get(user_id=user.id)
        self.assertEqual(profile.telegram_id, 777001)
        self.assertEqual(profile.display_name, "zzz")
        self.assertTrue(bool(profile.avatar_file))

        stale_profile.refresh_from_db()
        self.assertIsNone(stale_profile.telegram_id)

    def test_auth_me_keeps_display_name_separate_from_username(self):
        user = User.objects.create_user(username="nick-separate@example.com", email="nick-separate@example.com", password="secret123")
        headers = _auth_headers(user.id, "nick-separate@example.com", "nick-separate@example.com")

        profile_response = self.client.patch(
            "/api/profile/settings/",
            data={"display_name": "FreshNick"},
            content_type="application/json",
            **headers,
        )
        self.assertEqual(profile_response.status_code, 200)

        auth_response = self.client.get("/api/auth/me/", **headers)
        self.assertEqual(auth_response.status_code, 200)
        payload = auth_response.json()
        self.assertEqual(payload["display_name"], "FreshNick")
        self.assertEqual(payload["username"], "nick-separate@example.com")

    def test_remove_uploaded_avatar_does_not_keep_local_avatar_url_as_photo(self):
        user = User.objects.create_user(username="avatar-clear@example.com", email="avatar-clear@example.com", password="secret123")
        headers = _auth_headers(user.id, "avatar-clear@example.com", "avatar-clear@example.com")

        avatar = SimpleUploadedFile("avatar.png", b"fakepngcontent", content_type="image/png")
        upload_response = self.client.patch(
            "/api/profile/settings/",
            data={"display_name": "Avatar User", "avatar": avatar},
            **headers,
        )
        self.assertEqual(upload_response.status_code, 200)
        avatar_url = upload_response.json()["photo"]
        self.assertEqual(avatar_url, f"/api/profile/avatar/{user.id}/")

        remove_headers = {
            **headers,
            "HTTP_X_AUTH_PHOTO": f"utf8:{avatar_url}",
        }
        remove_response = self.client.patch(
            "/api/profile/settings/",
            data={"remove_avatar": "true"},
            **remove_headers,
        )
        self.assertEqual(remove_response.status_code, 200)
        self.assertEqual(remove_response.json()["photo"], "")

    @patch("telegram_auth.views._resolve_remnawave_user", return_value=None)
    @patch("telegram_auth.views.verify_telegram_auth", return_value=True)
    @patch("telegram_auth.views.has_telegram_config", return_value=True)
    def test_link_telegram_to_email_account(self, _has_telegram_config, _verify_telegram_auth, _resolve_remnawave):
        user = User.objects.create_user(username="link@example.com", email="link@example.com", password="secret123")
        headers = _auth_headers(user.id, "link@example.com", "link@example.com")

        response = self.client.post(
            "/api/auth/link/telegram/",
            data={"id": 880011, "username": "tg_linked", "auth_date": str(int(views.time()))},
            content_type="application/json",
            **headers,
        )
        self.assertEqual(response.status_code, 200)
        payload = response.json()
        self.assertEqual(payload["id"], user.id)
        self.assertEqual(payload["telegram_id"], 880011)
        self.assertTrue(payload["has_email_auth"])
        self.assertTrue(payload["has_telegram_auth"])
        self.assertFalse(payload["can_link_telegram"])

        profile = ChatUserProfile.objects.get(user_id=user.id)
        self.assertEqual(profile.telegram_id, 880011)
        self.assertEqual(profile.telegram_username, "tg_linked")
        self.assertTrue(AuthIdentity.objects.filter(user_id=user.id, provider="email", provider_user_id="link@example.com").exists())
        self.assertTrue(AuthIdentity.objects.filter(user_id=user.id, provider="telegram", provider_user_id="880011").exists())

    def test_link_email_to_telegram_account(self):
        user = User.objects.create(username="tg_991001", email="")
        user.set_unusable_password()
        user.save(update_fields=["password"])

        ChatUserProfile.objects.create(
            user_id=user.id,
            telegram_id=991001,
            telegram_username="tg_only_user",
            username="tg_only_user",
            auth_provider="telegram",
        )
        AuthIdentity.objects.create(user=user, provider="telegram", provider_user_id="991001")

        headers = {
            "HTTP_X_AUTH_USER_ID": str(user.id),
            "HTTP_X_AUTH_USERNAME": "tg_only_user",
            "HTTP_X_AUTH_TELEGRAM_ID": "991001",
            "HTTP_X_AUTH_TELEGRAM_USERNAME": "tg_only_user",
            "HTTP_X_AUTH_PROVIDER": "telegram",
            "HTTP_X_TELEGRAM_USER_ID": str(user.id),
            "HTTP_X_TELEGRAM_USERNAME": "tg_only_user",
        }

        response = self.client.post(
            "/api/auth/link/email/",
            data={"email": "linked.from.tg@example.com", "password": "secret123"},
            content_type="application/json",
            **headers,
        )
        self.assertEqual(response.status_code, 200)
        payload = response.json()
        self.assertEqual(payload["id"], user.id)
        self.assertEqual(payload["email"], "linked.from.tg@example.com")
        self.assertTrue(payload["has_email_auth"])
        self.assertTrue(payload["has_telegram_auth"])
        self.assertFalse(payload["can_link_email"])

        user.refresh_from_db()
        self.assertEqual(user.email, "linked.from.tg@example.com")
        self.assertEqual(user.username, "linked.from.tg@example.com")
        self.assertTrue(user.check_password("secret123"))
        self.assertTrue(
            AuthIdentity.objects.filter(
                user_id=user.id,
                provider="email",
                provider_user_id="linked.from.tg@example.com",
            ).exists()
        )
