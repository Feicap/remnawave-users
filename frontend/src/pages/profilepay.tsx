import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router'
import type { TelegramUser } from '../types/telegram'
import { isAdminUserId } from '../utils/admin'

interface AuthenticatedUser extends TelegramUser {
  token: string
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

export default function ProfilePay() {
  const navigate = useNavigate()
  const [user] = useState<AuthenticatedUser | null>(() => getStoredUser())

  useEffect(() => {
    if (!user) {
      navigate('/auth')
    }
  }, [navigate, user])

  if (!user) {
    return <div>Loading...</div>
  }

  const canViewAdminPanel = isAdminUserId(user.id)

  function handleProfileDashboardClick() {
    navigate('/profile')
  }

  function handleAdminPanelClick() {
    navigate('/admin')
  }

  function handleAuthClick() {
    localStorage.removeItem('tg_user')
    localStorage.removeItem('token')
    localStorage.removeItem('subscription_url')
    navigate('/auth')
  }

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
                data-alt="User's Telegram profile picture"
                style={{
                  backgroundImage: `url("${user.photo || 'https://lh3.googleusercontent.com/aida-public/AB6AXuD7QfEnuqRCntNYH9h2Vpo3jzR2BMfMqxHuHq-ivlguZcwzF_lfmadLZHf4vT8CfrKoIUNDPR1MmHqWK_suVK1pQOJXx0sSYBdAc3HCdZbWyuwNnuAj95xWWZilTRSMiKUfTt-6lFPSIvaV577Wik1oYO_ONDLJYuA5yaDJJSU7PwQfTQftZAILVh17O3KQr1s3dq56Z1g5mUvalbeTkomtJfUowYTnX-9km8Hdzb5Wm8IyfcVbawTAHqT3EkFdUrXJHLDkkTopp-E'}")`,
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
              <button
                onClick={handleProfileDashboardClick}
                className="flex items-center gap-3 px-3 py-2 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-800/50 cursor-pointer text-left"
                type="button"
              >
                <span className="material-symbols-outlined text-gray-500 dark:text-white">dashboard</span>
                <p className="text-gray-700 dark:text-white text-sm font-medium leading-normal">Панель управления</p>
              </button>

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

              <a className="flex items-center gap-3 px-3 py-2 rounded-lg bg-primary/10 dark:bg-[#232f48]" href="#">
                <span className="material-symbols-outlined text-primary dark:text-white">payment</span>
                <p className="text-primary dark:text-white text-sm font-medium leading-normal">Оплата</p>
              </a>
            </nav>
          </div>
        </div>

        <div onClick={handleAuthClick} className="flex flex-col gap-4">
          <button className="flex w-full cursor-pointer items-center justify-center overflow-hidden rounded-lg h-10 px-4 bg-primary text-white text-sm font-bold leading-normal tracking-[0.015em] hover:bg-primary/90">
            <span className="truncate">Выйти</span>
          </button>
        </div>
      </aside>

      <main className="flex-1 p-6 lg:p-10">
        <div className="max-w-xl mx-auto">
          <div className="flex flex-col gap-1 mb-8">
            <p className="text-gray-900 dark:text-white text-4xl font-black leading-tight tracking-[-0.033em]">Форма оплаты</p>
            <p className="text-gray-500 dark:text-[#92a4c9] text-base font-normal leading-normal">
              Загрузите скриншот, чтобы подтвердить ваш платеж.
            </p>
          </div>

          <div className="bg-white dark:bg-[#111722] rounded-xl border border-gray-200 dark:border-[#324467] p-6 lg:p-8">
            <form className="flex flex-col gap-6">
              <div>
                <label
                  className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2"
                  htmlFor="screenshot-upload"
                >
                  Скриншот оплаты
                </label>
                <div className="mt-2 flex justify-center rounded-xl border-2 border-dashed border-gray-300 dark:border-gray-700 px-6 pt-5 pb-6">
                  <div className="text-center">
                    <span className="material-symbols-outlined text-5xl text-gray-400 dark:text-gray-500">
                      upload_file
                    </span>
                    <div className="mt-4 flex text-sm leading-6 text-gray-600 dark:text-gray-400">
                      <label
                        className="relative cursor-pointer rounded-md font-semibold text-primary hover:text-primary/90"
                        htmlFor="file-upload"
                      >
                        <span>Загрузите файл</span>
                        <input className="sr-only" id="file-upload" name="file-upload" type="file" />
                      </label>
                      <p className="pl-1">или перетащите сюда</p>
                    </div>
                    <p className="text-xs leading-5 text-gray-500 dark:text-gray-500">PNG, JPG, GIF до 10MB</p>
                  </div>
                </div>
              </div>

              <button
                className="flex w-full cursor-pointer items-center justify-center gap-2 overflow-hidden rounded-lg h-11 px-4 bg-primary text-white text-sm font-bold leading-normal tracking-[0.015em] hover:bg-primary/90 mt-2"
                type="submit"
              >
                <span className="material-symbols-outlined text-base">send</span>
                <span className="truncate">Отправить подтверждение</span>
              </button>
            </form>
          </div>
        </div>
      </main>
    </div>
  )
}
