import type { TelegramUser } from '../types/telegram'

interface AuthenticatedUser extends TelegramUser {
  token?: string
}

export function getStoredUser(): AuthenticatedUser | null {
  const stored = localStorage.getItem('tg_user')
  if (!stored) {
    return null
  }

  try {
    return JSON.parse(stored) as AuthenticatedUser
  } catch {
    return null
  }
}

export function buildAuthHeaders(user: TelegramUser): HeadersInit {
  const token = localStorage.getItem('token') ?? ''
  return {
    Authorization: `Bearer ${token}`,
    'X-Telegram-User-Id': String(user.id),
    'X-Telegram-Username': user.username ?? '',
  }
}
