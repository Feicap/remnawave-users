import type { SyntheticEvent } from 'react'
import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router'
import { useChatUnreadPing } from '../hooks/useChatUnreadPing'
import type { AuthUser } from '../types/auth'
import { isAdminUser } from '../utils/admin'
import { clearStoredAuth, getStoredUser, refreshStoredAuthUser, withStoredAvatarVersion } from '../utils/auth'

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

export default function Profile() {
  const navigate = useNavigate()
  const [user, setUser] = useState<AuthUser | null>(() => getStoredUser())
  const { totalUnread } = useChatUnreadPing(user)
  const initialExpiry = new Date('2026-04-04T13:33:00')
  const now = new Date()
  const msInDay = 24 * 60 * 60 * 1000
  const renewPeriodMs = 30 * msInDay

  useEffect(() => {
    if (!user) {
      navigate('/auth')
      return
    }

    refreshStoredAuthUser(user)
      .then((nextUser) => {
        setUser((previous) => ({
          ...nextUser,
          photo: previous?.photo?.includes('/api/profile/avatar/')
            ? withStoredAvatarVersion(nextUser.photo)
            : nextUser.photo,
        }))
      })
      .catch(() => {
        // Оставляем данные из localStorage, если сейчас не удалось обновить профиль.
      })
  }, [navigate, user?.id])

  let expiresAt = initialExpiry
  if (now.getTime() > initialExpiry.getTime()) {
    const elapsedMs = now.getTime() - initialExpiry.getTime()
    const periodsPassed = Math.floor(elapsedMs / renewPeriodMs) + 1
    expiresAt = new Date(initialExpiry.getTime() + periodsPassed * renewPeriodMs)
  }

  const daysLeft = Math.max(0, Math.ceil((expiresAt.getTime() - now.getTime()) / msInDay))
  const expiresAtFormatted = expiresAt.toLocaleString('ru-RU', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })

  function handleLogout() {
    clearStoredAuth()
    navigate('/auth')
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

  function handleProfileSettingsClick() {
    navigate('/profile-settings')
  }

  if (!user) {
    return <div>Загрузка...</div>
  }

  const canViewAdminPanel = isAdminUser(user)
  const displayName = getDisplayName(user)
  const telegramId = getTelegramId(user)
  const avatarUrl = getAvatarUrl(user.photo)

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
                <a className="flex items-center gap-3 rounded-lg bg-primary/10 px-3 py-2 dark:bg-[#232f48]" href="#">
                  <span className="material-symbols-outlined text-primary dark:text-white">dashboard</span>
                  <p className="text-sm font-medium leading-normal text-primary dark:text-white">Панель управления</p>
                </a>
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
                <button
                  className="cursor-pointer rounded-lg px-3 py-2 text-left hover:bg-gray-100 dark:hover:bg-gray-800/50"
                  onClick={handleProfileSettingsClick}
                  type="button"
                >
                  <div className="flex items-center gap-3">
                    <span className="material-symbols-outlined text-gray-500 dark:text-white">manage_accounts</span>
                    <p className="text-sm font-medium leading-normal text-gray-700 dark:text-white">Настройки профиля</p>
                  </div>
                </button>
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
          <div className="mb-8 flex flex-wrap items-center justify-between gap-4">
            <div className="flex flex-col gap-1">
              <p className="text-4xl font-black leading-tight tracking-[-0.033em] text-gray-900 dark:text-white">Панель управления</p>
              <p className="text-base font-normal leading-normal text-gray-500 dark:text-[#92a4c9]">Обзор вашей подписки.</p>
            </div>
            <button className="flex h-10 min-w-[84px] cursor-pointer items-center justify-center gap-2 overflow-hidden rounded-lg bg-primary px-4 text-sm font-bold leading-normal tracking-[0.015em] text-white hover:bg-primary/90">
              <span className="material-symbols-outlined text-base">autorenew</span>
              <span className="truncate">Продлить подписку</span>
            </button>
          </div>

          <div className="mb-10 grid grid-cols-1 gap-6 md:grid-cols-2">
            <div className="flex flex-col gap-2 rounded-xl border border-gray-200 bg-white p-6 dark:border-[#324467] dark:bg-[#111722]">
              <p className="text-base font-medium leading-normal text-gray-600 dark:text-white">Статус подписки</p>
              <div className="flex items-center gap-2">
                <span className="h-3 w-3 rounded-full bg-green-500"></span>
                <p className="text-2xl font-bold leading-tight tracking-light text-green-500">Активна</p>
              </div>
            </div>
            <div className="flex flex-col gap-2 rounded-xl border border-gray-200 bg-white p-6 dark:border-[#324467] dark:bg-[#111722]">
              <p className="text-base font-medium leading-normal text-gray-600 dark:text-white">Истекает</p>
              <p className="text-2xl font-bold leading-tight tracking-light text-gray-900 dark:text-white">{expiresAtFormatted}</p>
              <p className="text-sm font-normal leading-normal text-gray-500 dark:text-[#92a4c9]">Истекает через {daysLeft} дней.</p>
            </div>
          </div>

          <div className="rounded-xl border border-gray-200 bg-white p-6 dark:border-[#324467] dark:bg-[#111722]">
            <h2 className="mb-4 text-lg font-bold leading-tight tracking-[-0.015em] text-gray-900 dark:text-white">Как подключиться</h2>
            <div className="flex flex-col gap-4">
              {user.subscription_url ? (
                <p className="text-sm text-gray-500 dark:text-[#92a4c9]">
                  Перейдите по ссылке:{' '}
                  <a className="text-primary underline hover:text-primary/80" href={user.subscription_url} rel="noopener noreferrer" target="_blank">
                    {user.subscription_url}
                  </a>
                </p>
              ) : (
                <p className="text-sm text-gray-500 dark:text-[#92a4c9]">Администратор не выдал вам доступ.</p>
              )}
            </div>
          </div>
        </div>
      </main>
    </div>
  )
}
