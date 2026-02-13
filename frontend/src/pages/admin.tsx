import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router'
import type { TelegramUser } from '../types/telegram'
import { getStoredUser } from '../utils/auth'
import { isAdminUserId } from '../utils/admin'

interface AuthenticatedUser extends TelegramUser {
  token: string
}

const env = import.meta.env as Record<string, string | undefined>
const grafanaDomain = String(env.GRAFANA_DOMAIN ?? '').trim()
const GRAFANA_URL = grafanaDomain ? `https://${grafanaDomain.replace(/\/+$/, '')}/dashboard/` : ''

const ADMIN_ROWS = [
  { id: '@john_doe', plan: 'Премиум (месяц)', status: 'Активен', end: '2026-03-31', statusColor: 'text-green-500 bg-green-500/10' },
  { id: '@jane_smith', plan: 'Премиум (год)', status: 'Истек', end: '2025-12-15', statusColor: 'text-red-500 bg-red-500/10' },
  { id: '@test_user', plan: 'Пробный', status: 'Пробный', end: '2026-02-20', statusColor: 'text-blue-500 bg-blue-500/10' },
  { id: '@sam_wilson', plan: 'Премиум (месяц)', status: 'Скоро истекает', end: '2026-02-28', statusColor: 'text-yellow-500 bg-yellow-500/10' },
]

export default function Admin() {
  const navigate = useNavigate()
  const [user] = useState<AuthenticatedUser | null>(() => getStoredUser() as AuthenticatedUser | null)

  useEffect(() => {
    if (!user) {
      navigate('/auth')
      return
    }

    if (!isAdminUserId(user.id)) {
      navigate('/profile')
    }
  }, [navigate, user])

  if (!user || !isAdminUserId(user.id)) {
    return <div>Loading...</div>
  }

  function handleBackToProfile() {
    navigate('/profile')
  }

  function handlePaymentCheck() {
    navigate('/admin-check')
  }

  function handleLogout() {
    localStorage.removeItem('tg_user')
    localStorage.removeItem('token')
    localStorage.removeItem('subscription_url')
    navigate('/auth')
  }

  return (
    <div className="flex min-h-screen flex-col md:h-screen md:flex-row">
      <aside className="w-full md:w-64 md:flex-shrink-0 bg-white dark:bg-[#111722] p-4 flex flex-col justify-between border-b md:border-b-0 md:border-r border-gray-200 dark:border-gray-800">
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
                  {user.username || 'Администратор'}
                </h1>
                <p className="text-gray-500 dark:text-[#92a4c9] text-sm font-normal leading-normal">ID: {user.id}</p>
              </div>
            </div>
            <nav className="flex flex-col gap-2">
              <a className="flex items-center gap-3 px-3 py-2 rounded-lg bg-primary/10 dark:bg-[#232f48]" href="#">
                <span className="material-symbols-outlined text-primary dark:text-white">admin_panel_settings</span>
                <p className="text-primary dark:text-white text-sm font-medium leading-normal">Админ панель</p>
              </a>
              <button
                onClick={handlePaymentCheck}
                className="flex items-center gap-3 px-3 py-2 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-800/50 cursor-pointer text-left"
                type="button"
              >
                <span className="material-symbols-outlined text-gray-500 dark:text-white">credit_card</span>
                <p className="text-gray-700 dark:text-white text-sm font-medium leading-normal">Проверка оплаты</p>
              </button>
              {GRAFANA_URL ? (
                <a
                  href={GRAFANA_URL}
                  target="_blank"
                  rel="noreferrer"
                  className="flex items-center gap-3 px-3 py-2 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-800/50"
                >
                  <span className="material-symbols-outlined text-gray-500 dark:text-white">monitoring</span>
                  <p className="text-gray-700 dark:text-white text-sm font-medium leading-normal">Grafana</p>
                </a>
              ) : null}
              <button
                onClick={handleBackToProfile}
                className="flex items-center gap-3 px-3 py-2 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-800/50 cursor-pointer text-left"
                type="button"
              >
                <span className="material-symbols-outlined text-gray-500 dark:text-white">arrow_back</span>
                <p className="text-gray-700 dark:text-white text-sm font-medium leading-normal">Обратно в профиль</p>
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

      <main className="flex-1 p-4 md:p-6 lg:p-10 overflow-y-auto">
        <div className="max-w-6xl mx-auto">
          <div className="flex flex-wrap justify-between items-center gap-4 mb-8">
            <div className="flex flex-col gap-1">
              <p className="text-gray-900 dark:text-white text-4xl font-black leading-tight tracking-[-0.033em]">
                Управление подписками
              </p>
              <p className="text-gray-500 dark:text-[#92a4c9] text-base font-normal leading-normal">
                Просмотр и управление подписками пользователей.
              </p>
            </div>
            <button className="flex min-w-[84px] cursor-pointer items-center justify-center gap-2 overflow-hidden rounded-lg h-10 px-4 bg-primary text-white text-sm font-bold leading-normal tracking-[0.015em] hover:bg-primary/90">
              <span className="material-symbols-outlined text-base">person_add</span>
              <span className="truncate">Добавить пользователя</span>
            </button>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-6 mb-8">
            <div className="flex flex-col gap-2 rounded-xl p-6 bg-white dark:bg-[#111722] border border-gray-200 dark:border-[#324467]">
              <p className="text-gray-600 dark:text-white text-base font-medium leading-normal">Всего пользователей</p>
              <p className="text-gray-900 dark:text-white tracking-light text-3xl font-bold leading-tight">97</p>
            </div>
            <div className="flex flex-col gap-2 rounded-xl p-6 bg-white dark:bg-[#111722] border border-gray-200 dark:border-[#324467]">
              <p className="text-gray-600 dark:text-white text-base font-medium leading-normal">Активные</p>
              <p className="text-green-500 tracking-light text-3xl font-bold leading-tight">78</p>
            </div>
            <div className="flex flex-col gap-2 rounded-xl p-6 bg-white dark:bg-[#111722] border border-gray-200 dark:border-[#324467]">
              <p className="text-gray-600 dark:text-white text-base font-medium leading-normal">Истекшие</p>
              <p className="text-red-500 tracking-light text-3xl font-bold leading-tight">19</p>
            </div>
          </div>

          <div className="bg-white dark:bg-[#111722] rounded-xl border border-gray-200 dark:border-[#324467] p-6">
            <div className="overflow-x-auto">
              <table className="min-w-full">
                <thead>
                  <tr className="border-b border-gray-200 dark:border-[#324467]">
                    <th className="px-4 py-3 text-left text-sm font-semibold text-gray-700 dark:text-white">ID (Telegram)</th>
                    <th className="px-4 py-3 text-left text-sm font-semibold text-gray-700 dark:text-white">Тариф</th>
                    <th className="px-4 py-3 text-left text-sm font-semibold text-gray-700 dark:text-white">Статус</th>
                    <th className="px-4 py-3 text-left text-sm font-semibold text-gray-700 dark:text-white">Дата окончания</th>
                  </tr>
                </thead>
                <tbody>
                  {ADMIN_ROWS.map((row) => (
                    <tr key={row.id} className="border-b border-gray-100 dark:border-[#1e2a40]">
                      <td className="px-4 py-4 text-sm font-medium text-gray-900 dark:text-white">{row.id}</td>
                      <td className="px-4 py-4 text-sm text-gray-600 dark:text-[#92a4c9]">{row.plan}</td>
                      <td className="px-4 py-4 text-sm">
                        <span className={`inline-flex items-center rounded-full px-2 py-1 text-xs font-medium ${row.statusColor}`}>
                          {row.status}
                        </span>
                      </td>
                      <td className="px-4 py-4 text-sm text-gray-600 dark:text-[#92a4c9]">{row.end}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      </main>
    </div>
  )
}
