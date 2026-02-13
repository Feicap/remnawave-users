import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router'
import type { TelegramUser } from '../types/telegram'
import { isAdminUserId } from '../utils/admin'

interface AuthenticatedUser extends TelegramUser {
  token: string
  subscription_url?: string
}

function getStoredUser(): AuthenticatedUser | null {
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

export default function Profile() {
  const navigate = useNavigate()
  const [user] = useState<AuthenticatedUser | null>(() => getStoredUser())
  const initialExpiry = new Date('2026-03-05T13:33:00')
  const now = new Date()
  const msInDay = 24 * 60 * 60 * 1000
  const renewPeriodMs = 30 * msInDay

  useEffect(() => {
    if (!user) {
      navigate('/auth')
    }
  }, [navigate, user])

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
    localStorage.removeItem('tg_user')
    localStorage.removeItem('token')
    localStorage.removeItem('subscription_url')
    navigate('/auth')
  }

  function handleProfilePayClick() {
    navigate('/profile-pay')
  }

  function handleAdminPanelClick() {
    navigate('/admin')
  }

  if (!user) {
    return <div>Loading...</div>
  }

  const canViewAdminPanel = isAdminUserId(user.id)

  return (
    <div className="flex h-screen">
      <aside className="w-64 flex-shrink-0 bg-white dark:bg-[#111722] p-4 flex flex-col justify-between border-r border-gray-200 dark:border-gray-800">
        <div className="flex flex-col gap-8">
          <div className="flex items-center gap-3 px-2">
            <span className="material-symbols-outlined text-primary text-3xl">shield</span>
            <span className="text-xl font-bold text-gray-900 dark:text-white">Мой VPS</span>
          </div>
          <div className="flex flex-col gap-4">
            <div className="flex items-center gap-3 px-3 py-2">
              <div
                className="bg-center bg-no-repeat aspect-square bg-cover rounded-full size-10"
                style={{
                  backgroundImage: `url("${user.photo || 'https://lh3.googleusercontent.com/aida-public/AB6AXuD7QfEnuqRCntNYH9h2Vpo3jzR2BMfMqxHuHq-ivlguZcwzF_lfmadLZHf4vT8CfrKoIUNDPR1MmHqWK_suVK1pQOJXx0sSYBdAc3HCdZbWyuwNnuAj95xWWZilTRSMiKUfTt-6lFPSIvaV577Wik1oYO_ONDLJYuA5yaDJJSU7PwQfDQftZAILVh17O3KQr1s3dq56Z1g5mUvalbeTkomtJfUowYTnX-9km8Hdzb5Wm8IyfcVbawTAHqT3EkFdUrXJHLDkkTopp-E'}")`,
                }}
              />
              <div className="flex flex-col">
                <h1 className="text-gray-900 dark:text-white text-base font-medium leading-normal">
                  {user.username || 'Пользователь'}
                </h1>
                <p className="text-gray-500 dark:text-[#92a4c9] text-sm font-normal leading-normal">ID: {user.id}</p>
              </div>
            </div>
            <nav className="flex flex-col gap-2">
              <a className="flex items-center gap-3 px-3 py-2 rounded-lg bg-primary/10 dark:bg-[#232f48]" href="#">
                <span className="material-symbols-outlined text-primary dark:text-white">dashboard</span>
                <p className="text-primary dark:text-white text-sm font-medium leading-normal">Панель управления</p>
              </a>
              <a
                className="flex items-center gap-3 px-3 py-2 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-800/50"
                href="#"
              >
                <span className="material-symbols-outlined text-gray-500 dark:text-white">menu_book</span>
                <p className="text-gray-700 dark:text-white text-sm font-medium leading-normal">Руководства</p>
              </a>
              {canViewAdminPanel ? (
                <button
                  className="flex items-center gap-3 px-3 py-2 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-800/50 cursor-pointer text-left"
                  onClick={handleAdminPanelClick}
                  type="button"
                >
                  <span className="material-symbols-outlined text-gray-500 dark:text-white">admin_panel_settings</span>
                  <p className="text-gray-700 dark:text-white text-sm font-medium leading-normal">Админ панель</p>
                </button>
              ) : null}
              <button
                onClick={handleProfilePayClick}
                className="flex items-center gap-3 px-3 py-2 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-800/50 cursor-pointer text-left"
                type="button"
              >
                <span className="material-symbols-outlined text-gray-500 dark:text-white">payment</span>
                <p className="text-gray-700 dark:text-white text-sm font-medium leading-normal">Оплата</p>
              </button>
            </nav>
          </div>
        </div>
        <div className="flex flex-col gap-4">
          <button
            onClick={handleLogout}
            className="flex w-full cursor-pointer items-center justify-center overflow-hidden rounded-lg h-10 px-4 bg-primary text-white text-sm font-bold leading-normal tracking-[0.015em] hover:bg-primary/90"
          >
            <span className="truncate">Выйти</span>
          </button>
        </div>
      </aside>
      <main className="flex-1 p-6 lg:p-10">
        <div className="max-w-4xl mx-auto">
          <div className="flex flex-wrap justify-between items-center gap-4 mb-8">
            <div className="flex flex-col gap-1">
              <p className="text-gray-900 dark:text-white text-4xl font-black leading-tight tracking-[-0.033em]">
                Панель управления
              </p>
              <p className="text-gray-500 dark:text-[#92a4c9] text-base font-normal leading-normal">
                Обзор вашей подписки.
              </p>
            </div>
            <button className="flex min-w-[84px] cursor-pointer items-center justify-center gap-2 overflow-hidden rounded-lg h-10 px-4 bg-primary text-white text-sm font-bold leading-normal tracking-[0.015em] hover:bg-primary/90">
              <span className="material-symbols-outlined text-base">autorenew</span>
              <span className="truncate">Продлить подписку</span>
            </button>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6 mb-10">
            <div className="flex flex-col gap-2 rounded-xl p-6 bg-white dark:bg-[#111722] border border-gray-200 dark:border-[#324467]">
              <p className="text-gray-600 dark:text-white text-base font-medium leading-normal">Статус подписки</p>
              <div className="flex items-center gap-2">
                <span className="w-3 h-3 rounded-full bg-green-500"></span>
                <p className="text-green-500 tracking-light text-2xl font-bold leading-tight">Активна</p>
              </div>
            </div>
            <div className="flex flex-col gap-2 rounded-xl p-6 bg-white dark:bg-[#111722] border border-gray-200 dark:border-[#324467]">
              <p className="text-gray-600 dark:text-white text-base font-medium leading-normal">Истекает</p>
              <p className="text-gray-900 dark:text-white tracking-light text-2xl font-bold leading-tight">{expiresAtFormatted}</p>
              <p className="text-gray-500 dark:text-[#92a4c9] text-sm font-normal leading-normal">
                Истекает через {daysLeft} дней.
              </p>
            </div>
          </div>
          <div className="bg-white dark:bg-[#111722] rounded-xl border border-gray-200 dark:border-[#324467] p-6">
            <h2 className="text-gray-900 dark:text-white text-lg font-bold leading-tight tracking-[-0.015em] mb-4">
              Как подключиться
            </h2>
            <div className="flex flex-col gap-4">
              <p className="text-gray-500 dark:text-[#92a4c9] text-sm">
                Перейдите по ссылке:{' '}
                <a
                  href={user.subscription_url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-primary underline hover:text-primary/80"
                >
                  {user.subscription_url}
                </a>
              </p>
            </div>
          </div>
        </div>
      </main>
    </div>
  )
}
