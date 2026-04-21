import type { FormEvent, SyntheticEvent } from 'react'
import { useCallback, useEffect, useState } from 'react'
import { useNavigate } from 'react-router'
import { useChatUnreadPing } from '../hooks/useChatUnreadPing'
import type { AuthUser } from '../types/auth'
import type { ProfileSettingsPayload } from '../types/profile'
import { isAdminUser } from '../utils/admin'
import {
  buildAuthHeaders,
  bumpStoredAvatarVersion,
  clearStoredAuth,
  getStoredUser,
  refreshStoredAuthUser,
  storeAuthUser,
  withStoredAvatarVersion,
} from '../utils/auth'

const DEFAULT_AVATAR =
  'https://lh3.googleusercontent.com/aida-public/AB6AXuD7QfEnuqRCntNYH9h2Vpo3jzR2BMfMqxHuHq-ivlguZcwzF_lfmadLZHf4vT8CfrKoIUNDPR1MmHqWK_suVK1pQOJXx0sSYBdAc3HCdZbWyuwNnuAj95xWWZilTRSMiKUfTt-6lFPSIvaV577Wik1oYO_ONDLJYuA5yaDJJSU7PwQfDQftZAILVh17O3KQr1s3dq56Z1g5mUvalbeTkomtJfUowYTnX-9km8Hdzb5Wm8IyfcVbawTAHqT3EkFdUrXJHLDkkTopp-E'

function getDisplayName(user: AuthUser): string {
  return user.display_name || user.username || user.telegram_username || user.email || 'Пользователь'
}

function getTelegramId(user: AuthUser): number | null {
  if (typeof user.telegram_id === 'number' && Number.isFinite(user.telegram_id)) {
    return user.telegram_id
  }
  return null
}

function getAvatarUrl(photo?: string): string {
  const normalized = withStoredAvatarVersion(photo)
  return normalized || DEFAULT_AVATAR
}

function handleAvatarError(event: SyntheticEvent<HTMLImageElement>): void {
  const image = event.currentTarget
  if (image.dataset.fallbackApplied === '1') {
    return
  }
  image.dataset.fallbackApplied = '1'
  image.src = DEFAULT_AVATAR
}

async function parseApiError(response: Response, fallback: string): Promise<string> {
  const payload = (await response.json().catch(() => null)) as { error?: string } | null
  return payload?.error || fallback
}

export default function ProfileSettings() {
  const navigate = useNavigate()
  const [user, setUser] = useState<AuthUser | null>(() => getStoredUser())
  const { totalUnread } = useChatUnreadPing(user)
  const [profileDisplayName, setProfileDisplayName] = useState('')
  const [avatarFile, setAvatarFile] = useState<File | null>(null)
  const [removeAvatar, setRemoveAvatar] = useState(false)
  const [isLoadingSettings, setIsLoadingSettings] = useState(true)
  const [isSavingProfile, setIsSavingProfile] = useState(false)
  const [profileError, setProfileError] = useState('')
  const [profileNotice, setProfileNotice] = useState('')

  const canViewAdminPanel = Boolean(user && isAdminUser(user))

  const handleUnauthorized = useCallback(() => {
    clearStoredAuth()
    navigate('/auth')
  }, [navigate])

  const loadProfileSettings = useCallback(async () => {
    if (!user) {
      return
    }

    setIsLoadingSettings(true)
    try {
      const response = await fetch('/api/profile/settings/', {
        headers: buildAuthHeaders(user),
      })
      if (response.status === 401 || response.status === 403) {
        handleUnauthorized()
        return
      }
      if (!response.ok) {
        setProfileError(await parseApiError(response, 'Не удалось загрузить настройки профиля'))
        return
      }

      const payload = (await response.json()) as ProfileSettingsPayload
      setProfileDisplayName(payload.display_name || '')
      setProfileError('')
    } catch {
      setProfileError('Сетевая ошибка при загрузке настроек профиля')
    } finally {
      setIsLoadingSettings(false)
    }
  }, [handleUnauthorized, user])

  useEffect(() => {
    if (!user) {
      navigate('/auth')
      return
    }

    let cancelled = false
    refreshStoredAuthUser(user)
      .then((nextUser) => {
        if (!cancelled) {
          setUser((previous) => ({
            ...nextUser,
            photo: previous?.photo?.includes('/api/profile/avatar/')
              ? withStoredAvatarVersion(nextUser.photo)
              : nextUser.photo,
          }))
        }
      })
      .catch(() => {
        // Оставляем данные из localStorage, если сейчас не удалось обновить профиль.
      })

    return () => {
      cancelled = true
    }
  }, [navigate, user?.id])

  useEffect(() => {
    loadProfileSettings().catch(() => {
      setProfileError('Не удалось загрузить настройки профиля')
      setIsLoadingSettings(false)
    })
  }, [loadProfileSettings])

  if (!user) {
    return <div>Загрузка...</div>
  }

  const displayName = getDisplayName(user)
  const telegramId = getTelegramId(user)
  const avatarUrl = getAvatarUrl(user.photo)

  async function handleSaveProfileSettings(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!user) {
      return
    }

    const normalizedDisplayName = profileDisplayName.trim()
    const formData = new FormData()
    formData.append('display_name', normalizedDisplayName)
    if (avatarFile) {
      formData.append('avatar', avatarFile)
    }
    if (removeAvatar) {
      formData.append('remove_avatar', 'true')
    }

    setIsSavingProfile(true)
    setProfileError('')
    setProfileNotice('')

    try {
      const response = await fetch('/api/profile/settings/', {
        method: 'PATCH',
        headers: buildAuthHeaders(user),
        body: formData,
      })
      if (response.status === 401 || response.status === 403) {
        handleUnauthorized()
        return
      }
      if (!response.ok) {
        setProfileError(await parseApiError(response, 'Не удалось сохранить настройки профиля'))
        return
      }

      const payload = (await response.json()) as ProfileSettingsPayload
      const avatarUpdated = Boolean(avatarFile || removeAvatar)
      if (avatarUpdated) {
        bumpStoredAvatarVersion()
      }

      const nextUser: AuthUser = {
        ...user,
        display_name: payload.display_name,
        username: payload.username,
        photo: withStoredAvatarVersion(payload.photo),
        email: payload.email || user.email,
        telegram_id: typeof payload.telegram_id === 'number' ? payload.telegram_id : user.telegram_id,
        telegram_username: payload.telegram_username || user.telegram_username,
        auth_provider: payload.auth_provider === 'telegram' ? 'telegram' : 'email',
      }
      storeAuthUser(nextUser)
      setUser(nextUser)

      try {
        const refreshed = await refreshStoredAuthUser(nextUser)
        const refreshedUser: AuthUser = {
          ...refreshed,
          photo: withStoredAvatarVersion(refreshed.photo),
        }
        storeAuthUser(refreshedUser)
        setUser(refreshedUser)
      } catch {
        // Не блокируем UX, если автообновление профиля временно недоступно.
      }

      setAvatarFile(null)
      setRemoveAvatar(false)
      setProfileNotice('Профиль обновлён')
    } catch {
      setProfileError('Сетевая ошибка при сохранении профиля')
    } finally {
      setIsSavingProfile(false)
    }
  }

  function handleLogout() {
    clearStoredAuth()
    navigate('/auth')
  }

  function handleProfileClick() {
    navigate('/profile')
  }

  function handleProfilePayClick() {
    navigate('/profile-pay')
  }

  function handleAdminPanelClick() {
    navigate('/admin')
  }

  function handleChatClick() {
    navigate('/chat')
  }

  return (
    <div className="flex min-h-screen flex-col md:h-screen md:flex-row">
      <aside className="w-full border-b border-gray-200 bg-white p-4 dark:border-gray-800 dark:bg-[#111722] md:w-64 md:flex-shrink-0 md:border-b-0 md:border-r">
        <div className="flex flex-col justify-between gap-8 md:h-full">
          <div className="flex flex-col gap-8">
            <div className="flex items-center gap-3 px-2">
              <span className="material-symbols-outlined text-3xl text-primary">shield</span>
              <span className="text-xl font-bold text-gray-900 dark:text-white">Мой VPS</span>
            </div>
            <div className="flex flex-col gap-4">
              <div className="flex items-center gap-3 px-3 py-2">
                <div className="size-10 shrink-0 overflow-hidden rounded-full bg-gray-100 dark:bg-[#1a2539]">
                  <img
                    alt={displayName}
                    className="size-10 rounded-full object-cover object-center"
                    onError={handleAvatarError}
                    src={avatarUrl}
                  />
                </div>
                <div className="flex flex-col">
                  <h1 className="text-base font-medium leading-normal text-gray-900 dark:text-white">{displayName}</h1>
                  {user.email ? (
                    <p className="text-sm font-normal leading-normal text-gray-500 dark:text-[#92a4c9]">{user.email}</p>
                  ) : null}
                  {telegramId !== null ? (
                    <p className="text-sm font-normal leading-normal text-gray-500 dark:text-[#92a4c9]">
                      Telegram ID: {telegramId}
                    </p>
                  ) : null}
                </div>
              </div>
              <nav className="flex flex-col gap-2">
                <button
                  className="cursor-pointer rounded-lg px-3 py-2 text-left hover:bg-gray-100 dark:hover:bg-gray-800/50"
                  onClick={handleProfileClick}
                  type="button"
                >
                  <div className="flex items-center gap-3">
                    <span className="material-symbols-outlined text-gray-500 dark:text-white">dashboard</span>
                    <p className="text-sm font-medium leading-normal text-gray-700 dark:text-white">Панель управления</p>
                  </div>
                </button>
                <button
                  className="cursor-pointer rounded-lg px-3 py-2 text-left hover:bg-gray-100 dark:hover:bg-gray-800/50"
                  onClick={handleChatClick}
                  type="button"
                >
                  <div className="flex items-center gap-3">
                    <div className="relative inline-flex items-center">
                      <span className="material-symbols-outlined text-gray-500 dark:text-white">chat</span>
                      {totalUnread > 0 ? (
                        <span className="absolute -right-2 -top-1 inline-flex min-w-4 items-center justify-center rounded-full bg-red-500 px-1 text-[10px] font-semibold text-white">
                          {totalUnread > 99 ? '99+' : totalUnread}
                        </span>
                      ) : null}
                    </div>
                    <p className="text-sm font-medium leading-normal text-gray-700 dark:text-white">Чат</p>
                  </div>
                </button>
                {canViewAdminPanel ? (
                  <button
                    className="cursor-pointer rounded-lg px-3 py-2 text-left hover:bg-gray-100 dark:hover:bg-gray-800/50"
                    onClick={handleAdminPanelClick}
                    type="button"
                  >
                    <div className="flex items-center gap-3">
                      <span className="material-symbols-outlined text-gray-500 dark:text-white">admin_panel_settings</span>
                      <p className="text-sm font-medium leading-normal text-gray-700 dark:text-white">Админ-панель</p>
                    </div>
                  </button>
                ) : null}
                <a className="flex items-center gap-3 rounded-lg bg-primary/10 px-3 py-2 dark:bg-[#232f48]" href="#">
                  <span className="material-symbols-outlined text-primary dark:text-white">manage_accounts</span>
                  <p className="text-sm font-medium leading-normal text-primary dark:text-white">Настройки профиля</p>
                </a>
                <button
                  className="cursor-pointer rounded-lg px-3 py-2 text-left hover:bg-gray-100 dark:hover:bg-gray-800/50"
                  onClick={handleProfilePayClick}
                  type="button"
                >
                  <div className="flex items-center gap-3">
                    <span className="material-symbols-outlined text-gray-500 dark:text-white">payment</span>
                    <p className="text-sm font-medium leading-normal text-gray-700 dark:text-white">Оплата</p>
                  </div>
                </button>
              </nav>
            </div>
          </div>
          <div className="flex flex-col gap-4">
            <button
              className="flex h-10 w-full cursor-pointer items-center justify-center overflow-hidden rounded-lg bg-primary px-4 text-sm font-bold leading-normal tracking-[0.015em] text-white hover:bg-primary/90"
              onClick={handleLogout}
              type="button"
            >
              <span className="truncate">Выйти</span>
            </button>
          </div>
        </div>
      </aside>

      <main className="flex-1 overflow-y-auto p-4 md:p-6 lg:p-10">
        <div className="mx-auto max-w-4xl">
          <section className="rounded-xl border border-gray-200 bg-white p-6 dark:border-[#324467] dark:bg-[#111722]">
            <h2 className="mb-4 text-lg font-bold text-gray-900 dark:text-white">Настройки профиля</h2>
            <form className="grid grid-cols-1 gap-4 md:grid-cols-2" onSubmit={handleSaveProfileSettings}>
              <div className="md:col-span-2 flex items-center gap-3 rounded-lg border border-gray-200 bg-gray-50 px-4 py-3 dark:border-[#324467] dark:bg-[#0f1728]">
                <div className="size-12 shrink-0 overflow-hidden rounded-full bg-gray-100 dark:bg-[#1a2539]">
                  <img
                    alt={displayName}
                    className="size-12 rounded-full object-cover object-center"
                    onError={handleAvatarError}
                    src={avatarUrl}
                  />
                </div>
                <div className="text-sm text-gray-600 dark:text-[#92a4c9]">
                  Актуальные имя и аватар применяются в шапке и чатах.
                </div>
              </div>

              <label className="flex flex-col gap-2 md:col-span-2">
                <span className="text-sm font-medium text-gray-700 dark:text-white">Ник в чате</span>
                <input
                  className="h-10 rounded-lg border border-gray-300 bg-white px-3 text-sm text-gray-900 outline-none focus:border-primary dark:border-[#324467] dark:bg-[#0d1525] dark:text-white"
                  maxLength={64}
                  onChange={(event) => setProfileDisplayName(event.target.value)}
                  placeholder="Введите ник"
                  value={profileDisplayName}
                />
              </label>

              <label className="flex flex-col gap-2 md:col-span-2">
                <span className="text-sm font-medium text-gray-700 dark:text-white">Аватар</span>
                <input
                  accept=".jpg,.jpeg,.png,.webp,.bmp,.heic,.svg"
                  className="block w-full text-sm text-gray-700 dark:text-gray-300 file:mr-3 file:rounded-md file:border-0 file:bg-primary file:px-3 file:py-2 file:text-sm file:font-semibold file:text-white hover:file:bg-primary/90"
                  onChange={(event) => {
                    setAvatarFile(event.target.files?.[0] ?? null)
                    if (event.target.files?.[0]) {
                      setRemoveAvatar(false)
                    }
                  }}
                  type="file"
                />
              </label>

              <label className="inline-flex items-center gap-2 text-sm text-gray-600 dark:text-[#92a4c9] md:col-span-2">
                <input
                  checked={removeAvatar}
                  onChange={(event) => {
                    setRemoveAvatar(event.target.checked)
                    if (event.target.checked) {
                      setAvatarFile(null)
                    }
                  }}
                  type="checkbox"
                />
                Удалить текущий аватар
              </label>

              <div className="md:col-span-2">
                {profileError ? <p className="text-sm text-red-500">{profileError}</p> : null}
                {profileNotice ? <p className="text-sm text-green-600">{profileNotice}</p> : null}
                {isLoadingSettings ? <p className="text-sm text-gray-500 dark:text-[#92a4c9]">Загрузка настроек...</p> : null}
              </div>

              <div className="md:col-span-2">
                <button
                  className="h-10 rounded-lg bg-primary px-4 text-sm font-semibold text-white hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-60"
                  disabled={isSavingProfile || isLoadingSettings}
                  type="submit"
                >
                  {isSavingProfile ? 'Сохранение...' : 'Сохранить профиль'}
                </button>
              </div>
            </form>
          </section>
        </div>
      </main>
    </div>
  )
}
