import type { AuthUser } from '../types/auth'

const AUTH_STORAGE_KEY = 'tg_user'
const TOKEN_STORAGE_KEY = 'token'
const SUBSCRIPTION_STORAGE_KEY = 'subscription_url'
const AVATAR_VERSION_STORAGE_KEY = 'profile_avatar_version'

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
  localStorage.removeItem(AVATAR_VERSION_STORAGE_KEY)
}

function toHeaderValue(value: string | undefined): string {
  const normalized = value?.trim() ?? ''
  if (!normalized) {
    return ''
  }
  return `utf8:${encodeURIComponent(normalized)}`
}

export function buildAuthHeaders(
  user: Pick<AuthUser, 'id' | 'username' | 'email' | 'telegram_id' | 'telegram_username' | 'photo' | 'auth_provider'>,
): HeadersInit {
  const token = localStorage.getItem(TOKEN_STORAGE_KEY) ?? ''
  const normalizedPhoto = user.photo?.trim() ?? ''
  const authPhoto = normalizedPhoto.includes('/api/profile/avatar/') ? normalizedPhoto.split('?')[0] : normalizedPhoto
  const fallbackEmail = user.email ?? (user.username?.includes('@') ? user.username : '')
  const fallbackTelegramId =
    typeof user.telegram_id === 'number' ? user.telegram_id : user.auth_provider === 'telegram' ? user.id : undefined
  const fallbackTelegramUsername =
    user.telegram_username ?? (user.auth_provider === 'telegram' && !user.username?.includes('@') ? user.username : '')

  return {
    Authorization: `Bearer ${token}`,
    'X-Telegram-User-Id': String(user.id),
    'X-Telegram-Username': toHeaderValue(user.username),
    'X-Auth-User-Id': String(user.id),
    'X-Auth-Username': toHeaderValue(user.username),
    'X-Auth-Email': toHeaderValue(fallbackEmail),
    'X-Auth-Telegram-Id': typeof fallbackTelegramId === 'number' ? String(fallbackTelegramId) : '',
    'X-Auth-Telegram-Username': toHeaderValue(fallbackTelegramUsername),
    'X-Auth-Photo': toHeaderValue(authPhoto),
    'X-Auth-Provider': toHeaderValue(user.auth_provider),
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

export function bumpStoredAvatarVersion(): string {
  const version = String(Date.now())
  localStorage.setItem(AVATAR_VERSION_STORAGE_KEY, version)
  return version
}

export function withStoredAvatarVersion(photo?: string): string {
  const normalized = photo?.trim() ?? ''
  if (!normalized) {
    return ''
  }
  const version = localStorage.getItem(AVATAR_VERSION_STORAGE_KEY)
  if (!version) {
    return normalized
  }
  const separator = normalized.includes('?') ? '&' : '?'
  return `${normalized}${separator}v=${encodeURIComponent(version)}`
}
