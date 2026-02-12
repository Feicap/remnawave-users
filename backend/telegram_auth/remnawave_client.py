import os
import asyncio
import logging
from typing import Optional
import aiohttp

logger = logging.getLogger(__name__)


async def get_user_by_telegram_id(telegram_id: int) -> Optional[dict]:
    """
    Fetch a single user by telegram_id from Remnawave API.
    Returns the user dict if found, else None.
    """

    base_url: str = os.getenv("REMNAWAVE_BASE_URL")
    token: str = os.getenv("REMNAWAVE_TOKEN")
    cookie: str = os.getenv("REMNAWAVE_COOKIE")
    logger.warning("telegram_id: %s", telegram_id)


    if not base_url or not token or not cookie:
        logger.warning("REMNAWAVE_BASE_URL, REMNAWAVE_TOKEN, or REMNAWAVE_COOKIE not configured")
        return None

    url = f"{base_url}/api/users/by-telegram-id/{telegram_id}"

    headers = {
        "Authorization": f"Bearer {token}"
    }

    cookies = {
        "KYccDWjT": cookie.split('=')[1]
    }

    try:
        async with aiohttp.ClientSession() as session:
            async with session.get(url, headers=headers, cookies=cookies, ssl=False) as resp:
                if resp.status != 200:
                    logger.warning("Remnawave returned status %s for telegram_id %s", resp.status, telegram_id)
                    return None
                data = await resp.json()
                return data.get("response")
    except Exception as e:
        logger.error("Error fetching user by telegram_id: %s", str(e))
        import traceback
        logger.error("Traceback: %s", traceback.format_exc())
        return None


def get_subscription_url_sync(telegram_id: int) -> Optional[str]:
    """
    Synchronous wrapper to fetch subscription_url by telegram_id.
    """
    logger.info("Getting subscription URL for telegram_id: %s", telegram_id)

    try:
        loop = asyncio.new_event_loop()
        asyncio.set_event_loop(loop)
        users = loop.run_until_complete(get_user_by_telegram_id(telegram_id))
        loop.close()

        if not users:
            logger.warning("User with telegram_id %s not found", telegram_id)
            return None

        # Если вернулся список, берём первый элемент
        if isinstance(users, list):
            user = users[0]
        else:
            user = users

        subscription_url = (
            user.get("subscriptionUrl") or
            user.get("subscription_url") or
            user.get("url")
        )
        if subscription_url:
            logger.info("Subscription URL found: %s", subscription_url)
            return subscription_url
        else:
            logger.warning("User found but no subscription URL")
            return None
    except Exception as e:
        logger.error("Error in get_subscription_url_sync: %s", str(e))
        import traceback
        logger.error("Traceback: %s", traceback.format_exc())
        return None