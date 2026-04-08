import type { AuthUser } from '../types/auth'

const AUTH_STORAGE_KEY = 'tg_user'
const TOKEN_STORAGE_KEY = 'token'
const SUBSCRIPTION_STORAGE_KEY = 'subscription_url'

export function getStoredUser(): AuthUser | null {
  const stored = localStorage.getItem(AUTH_STORAGE_KEY)
  if (!stored) {
    return null
  }

  try {
    return JSON.parse(stored) as AuthUser
  } catch {
    return null
  }
}

export function storeAuthUser(user: AuthUser): void {
  localStorage.setItem(AUTH_STORAGE_KEY, JSON.stringify(user))
  if (user.token) {
    localStorage.setItem(TOKEN_STORAGE_KEY, user.token)
  } else {
    localStorage.removeItem(TOKEN_STORAGE_KEY)
  }

  if (user.subscription_url) {
    localStorage.setItem(SUBSCRIPTION_STORAGE_KEY, user.subscription_url)
  } else {
    localStorage.removeItem(SUBSCRIPTION_STORAGE_KEY)
  }
}

export function clearStoredAuth(): void {
  localStorage.removeItem(AUTH_STORAGE_KEY)
  localStorage.removeItem(TOKEN_STORAGE_KEY)
  localStorage.removeItem(SUBSCRIPTION_STORAGE_KEY)
}

export function buildAuthHeaders(
  user: Pick<AuthUser, 'id' | 'username' | 'email' | 'telegram_id' | 'telegram_username' | 'photo' | 'auth_provider'>,
): HeadersInit {
  const token = localStorage.getItem(TOKEN_STORAGE_KEY) ?? ''
  const fallbackEmail = user.email ?? (user.username?.includes('@') ? user.username : '')
  const fallbackTelegramId =
    typeof user.telegram_id === 'number' ? user.telegram_id : user.auth_provider === 'telegram' ? user.id : undefined
  const fallbackTelegramUsername =
    user.telegram_username ?? (user.auth_provider === 'telegram' && !user.username?.includes('@') ? user.username : '')

  return {
    Authorization: `Bearer ${token}`,
    'X-Telegram-User-Id': String(user.id),
    'X-Telegram-Username': user.username ?? '',
    'X-Auth-User-Id': String(user.id),
    'X-Auth-Username': user.username ?? '',
    'X-Auth-Email': fallbackEmail ?? '',
    'X-Auth-Telegram-Id': typeof fallbackTelegramId === 'number' ? String(fallbackTelegramId) : '',
    'X-Auth-Telegram-Username': fallbackTelegramUsername ?? '',
    'X-Auth-Photo': user.photo ?? '',
    'X-Auth-Provider': user.auth_provider ?? '',
  }
}

export async function refreshStoredAuthUser(user: AuthUser): Promise<AuthUser> {
  const response = await fetch('/api/auth/me/', {
    headers: buildAuthHeaders(user),
  })

  if (!response.ok) {
    throw new Error('Не удалось обновить профиль')
  }

  const nextUser = (await response.json()) as AuthUser
  storeAuthUser(nextUser)
  return nextUser
}
