import { useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router'
import type { AuthUser } from '../types/auth'
import type { AdminUserItem, AdminUsersMetrics, AdminUsersResponse, ApiError } from '../types/admin'
import { buildAuthHeaders, clearStoredAuth, getStoredUser, refreshStoredAuthUser } from '../utils/auth'
import { isAdminUser } from '../utils/admin'

const REFRESH_INTERVAL_MS = 30_000

const DEFAULT_METRICS: AdminUsersMetrics = {
  total_users: 0,
  online_users: 0,
  online_window_minutes: 15,
  remnawave_access_users: 0,
  users_without_password: 0,
  active_today: 0,
}

type UserFilter = 'all' | 'online' | 'remnawave' | 'need-password'

const env = import.meta.env as Record<string, string | undefined>
const grafanaDomain = String(env.GRAFANA_DOMAIN ?? '').trim()
const GRAFANA_URL = grafanaDomain ? `https://${grafanaDomain.replace(/\/+$/, '')}/dashboard/` : ''

function getTelegramId(user: AuthUser): number | null {
  if (typeof user.telegram_id === 'number' && Number.isFinite(user.telegram_id)) {
    return user.telegram_id
  }
  return null
}

function formatDateTime(value: string | null): string {
  if (!value) {
    return 'Никогда'
  }

  const date = new Date(value)
  if (Number.isNaN(date.getTime())) {
    return 'Неверная дата'
  }

  return date.toLocaleString('ru-RU', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

async function parseApiError(response: Response, fallback: string): Promise<string> {
  const payload = (await response.json().catch(() => null)) as ApiError | null
  return payload?.error || fallback
}

function RemnawaveIcon({ title }: { title: string }) {
  return (
    <span className="inline-flex size-4 items-center justify-center" title={title}>
      <svg aria-hidden="true" className="size-4 text-cyan-500" viewBox="0 0 20 20">
        <path
          d="M2 11.2c2-3 4-3 6 0s4 3 6 0 4-3 4 0"
          fill="none"
          stroke="currentColor"
          strokeLinecap="round"
          strokeWidth="1.8"
        />
        <path d="M2 6.8c2-3 4-3 6 0s4 3 6 0 4-3 4 0" fill="none" stroke="currentColor" strokeLinecap="round" strokeWidth="1.8" />
      </svg>
    </span>
  )
}

export default function Admin() {
  const navigate = useNavigate()
  const [user, setUser] = useState<AuthUser | null>(() => getStoredUser())
  const [users, setUsers] = useState<AdminUserItem[]>([])
  const [metrics, setMetrics] = useState<AdminUsersMetrics>(DEFAULT_METRICS)
  const [search, setSearch] = useState('')
  const [filter, setFilter] = useState<UserFilter>('all')
  const [selectedUserId, setSelectedUserId] = useState<number | null>(null)
  const [editLogin, setEditLogin] = useState('')
  const [editPassword, setEditPassword] = useState('')
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [isLoading, setIsLoading] = useState(true)
  const [isSaving, setIsSaving] = useState(false)

  const selectedUser = useMemo(
    () => users.find((item) => item.id === selectedUserId) ?? null,
    [selectedUserId, users],
  )

  const filteredUsers = useMemo(() => {
    const normalizedSearch = search.trim().toLowerCase()
    return users.filter((item) => {
      if (filter === 'online' && !item.is_online) {
        return false
      }
      if (filter === 'remnawave' && !item.has_remnawave_access) {
        return false
      }
      if (filter === 'need-password' && item.has_password) {
        return false
      }
      if (!normalizedSearch) {
        return true
      }
      const target = `${item.id} ${item.login} ${item.email}`.toLowerCase()
      return target.includes(normalizedSearch)
    })
  }, [filter, search, users])

  const loadUsers = useCallback(
    async (showLoader: boolean) => {
      if (!user) {
        return
      }

      if (showLoader) {
        setIsLoading(true)
      }

      try {
        const response = await fetch('/api/admin/users/?limit=500', {
          headers: buildAuthHeaders(user),
        })

        if (!response.ok) {
          if (response.status === 401 || response.status === 403) {
            clearStoredAuth()
            navigate('/auth')
            return
          }
          setError(await parseApiError(response, 'Не удалось загрузить пользователей'))
          return
        }

        const payload = (await response.json()) as AdminUsersResponse
        setUsers(payload.items)
        setMetrics(payload.metrics)
        setError('')
      } catch {
        setError('Ошибка сети при загрузке пользователей')
      } finally {
        setIsLoading(false)
      }
    },
    [navigate, user],
  )

  useEffect(() => {
    const storedUser = getStoredUser()
    if (!storedUser) {
      navigate('/auth')
      return
    }

    if (!isAdminUser(storedUser)) {
      navigate('/profile')
      return
    }

    let isCancelled = false
    refreshStoredAuthUser(storedUser)
      .then((nextUser) => {
        if (!isCancelled) {
          setUser(nextUser)
        }
      })
      .catch(() => {
        if (!isCancelled) {
          setError('Не удалось обновить профиль администратора')
        }
      })

    return () => {
      isCancelled = true
    }
  }, [navigate])

  useEffect(() => {
    if (!user || !isAdminUser(user)) {
      return
    }

    loadUsers(true).catch(() => {
      setError('Не удалось загрузить пользователей')
    })

    const intervalId = window.setInterval(() => {
      loadUsers(false).catch(() => {
        setError('Не удалось обновить данные админки')
      })
    }, REFRESH_INTERVAL_MS)

    return () => {
      window.clearInterval(intervalId)
    }
  }, [loadUsers, user])

  useEffect(() => {
    if (users.length === 0) {
      setSelectedUserId(null)
      return
    }

    setSelectedUserId((previousId) => {
      if (previousId !== null && users.some((item) => item.id === previousId)) {
        return previousId
      }
      return users[0].id
    })
  }, [users])

  useEffect(() => {
    if (!selectedUser) {
      setEditLogin('')
      setEditPassword('')
      return
    }
    setEditLogin(selectedUser.login)
    setEditPassword('')
    setNotice('')
  }, [selectedUser])

  if (!user || !isAdminUser(user)) {
    return <div>Loading...</div>
  }

  const telegramId = getTelegramId(user)

  async function handleSaveCredentials() {
    if (!user || !selectedUser) {
      return
    }

    const normalizedLogin = editLogin.trim().toLowerCase()
    const payload: Record<string, string> = {}

    if (!normalizedLogin) {
      setError('Логин не может быть пустым')
      return
    }
    if (normalizedLogin !== selectedUser.login.toLowerCase()) {
      payload.login = normalizedLogin
    }

    if (editPassword.trim()) {
      payload.password = editPassword
    }

    if (!payload.login && !payload.password) {
      setNotice('Нет изменений для сохранения')
      return
    }

    setIsSaving(true)
    setError('')
    setNotice('')

    try {
      const response = await fetch(`/api/admin/users/${selectedUser.id}/`, {
        method: 'PATCH',
        headers: {
          ...buildAuthHeaders(user),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
      })

      if (!response.ok) {
        setError(await parseApiError(response, 'Не удалось обновить данные пользователя'))
        return
      }

      setEditPassword('')
      setNotice('Данные пользователя обновлены')
      await loadUsers(false)
    } catch {
      setError('Ошибка сети при сохранении пользователя')
    } finally {
      setIsSaving(false)
    }
  }

  async function handleResetPassword() {
    if (!user || !selectedUser) {
      return
    }

    if (!window.confirm(`Сбросить пароль для ${selectedUser.login}? После этого пользователь должен пройти регистрацию заново.`)) {
      return
    }

    setIsSaving(true)
    setError('')
    setNotice('')

    try {
      const response = await fetch(`/api/admin/users/${selectedUser.id}/reset-password/`, {
        method: 'POST',
        headers: buildAuthHeaders(user),
      })

      if (!response.ok) {
        setError(await parseApiError(response, 'Не удалось сбросить пароль пользователя'))
        return
      }

      setEditPassword('')
      setNotice('Пароль удалён. Пользователь должен зарегистрироваться заново.')
      await loadUsers(false)
    } catch {
      setError('Ошибка сети при сбросе пароля')
    } finally {
      setIsSaving(false)
    }
  }

  function handleBackToProfile() {
    navigate('/profile')
  }

  function handlePaymentCheck() {
    navigate('/admin-check')
  }

  function handleLogout() {
    clearStoredAuth()
    navigate('/auth')
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
                <div
                  className="size-10 rounded-full bg-cover bg-center bg-no-repeat"
                  style={{
                    backgroundImage: `url("${user.photo || 'https://lh3.googleusercontent.com/aida-public/AB6AXuD7QfEnuqRCntNYH9h2Vpo3jzR2BMfMqxHuHq-ivlguZcwzF_lfmadLZHf4vT8CfrKoIUNDPR1MmHqWK_suVK1pQOJXx0sSYBdAc3HCdZbWyuwNnuAj95xWWZilTRSMiKUfTt-6lFPSIvaV577Wik1oYO_ONDLJYuA5yaDJJSU7PwQfDQftZAILVh17O3KQr1s3dq56Z1g5mUvalbeTkomtJfUowYTnX-9km8Hdzb5Wm8IyfcVbawTAHqT3EkFdUrXJHLDkkTopp-E'}")`,
                  }}
                />
                <div className="flex flex-col">
                  <h1 className="text-base font-medium leading-normal text-gray-900 dark:text-white">
                    {user.username || 'Администратор'}
                  </h1>
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
                  <span className="material-symbols-outlined text-primary dark:text-white">admin_panel_settings</span>
                  <p className="text-sm font-medium leading-normal text-primary dark:text-white">Админ панель</p>
                </a>
                <button
                  className="cursor-pointer rounded-lg px-3 py-2 text-left hover:bg-gray-100 dark:hover:bg-gray-800/50"
                  onClick={handlePaymentCheck}
                  type="button"
                >
                  <div className="flex items-center gap-3">
                    <span className="material-symbols-outlined text-gray-500 dark:text-white">credit_card</span>
                    <p className="text-sm font-medium leading-normal text-gray-700 dark:text-white">Проверка оплаты</p>
                  </div>
                </button>
                {GRAFANA_URL ? (
                  <a
                    className="flex items-center gap-3 rounded-lg px-3 py-2 hover:bg-gray-100 dark:hover:bg-gray-800/50"
                    href={GRAFANA_URL}
                    rel="noreferrer"
                    target="_blank"
                  >
                    <span className="material-symbols-outlined text-gray-500 dark:text-white">monitoring</span>
                    <p className="text-sm font-medium leading-normal text-gray-700 dark:text-white">Grafana</p>
                  </a>
                ) : null}
                <button
                  className="cursor-pointer rounded-lg px-3 py-2 text-left hover:bg-gray-100 dark:hover:bg-gray-800/50"
                  onClick={handleBackToProfile}
                  type="button"
                >
                  <div className="flex items-center gap-3">
                    <span className="material-symbols-outlined text-gray-500 dark:text-white">arrow_back</span>
                    <p className="text-sm font-medium leading-normal text-gray-700 dark:text-white">Обратно в профиль</p>
                  </div>
                </button>
              </nav>
            </div>
          </div>
          <button
            className="flex h-10 w-full cursor-pointer items-center justify-center overflow-hidden rounded-lg bg-primary px-4 text-sm font-bold leading-normal tracking-[0.015em] text-white hover:bg-primary/90"
            onClick={handleLogout}
            type="button"
          >
            <span className="truncate">Выйти</span>
          </button>
        </div>
      </aside>

      <main className="flex-1 overflow-y-auto p-4 md:p-6 lg:p-10">
        <div className="mx-auto flex max-w-7xl flex-col gap-6">
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div className="flex flex-col gap-1">
              <p className="text-4xl font-black leading-tight tracking-[-0.033em] text-gray-900 dark:text-white">
                Управление пользователями
              </p>
              <p className="text-base font-normal leading-normal text-gray-500 dark:text-[#92a4c9]">
                Онлайн-активность, доступ Remnawave и управление авторизацией аккаунтов.
              </p>
            </div>
            <button
              className="flex h-10 min-w-[84px] cursor-pointer items-center justify-center gap-2 overflow-hidden rounded-lg bg-primary px-4 text-sm font-bold leading-normal tracking-[0.015em] text-white hover:bg-primary/90"
              onClick={() => {
                loadUsers(true).catch(() => {
                  setError('Не удалось обновить пользователей')
                })
              }}
              type="button"
            >
              <span className="material-symbols-outlined text-base">refresh</span>
              <span className="truncate">Обновить</span>
            </button>
          </div>

          <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-5">
            <div className="rounded-xl border border-gray-200 bg-white p-5 dark:border-[#324467] dark:bg-[#111722]">
              <p className="text-sm text-gray-500 dark:text-[#92a4c9]">Всего аккаунтов</p>
              <p className="text-2xl font-bold text-gray-900 dark:text-white">{metrics.total_users}</p>
            </div>
            <div className="rounded-xl border border-gray-200 bg-white p-5 dark:border-[#324467] dark:bg-[#111722]">
              <p className="text-sm text-gray-500 dark:text-[#92a4c9]">Онлайн на сайте</p>
              <p className="text-2xl font-bold text-green-600 dark:text-green-400">{metrics.online_users}</p>
              <p className="text-xs text-gray-500 dark:text-[#92a4c9]">За последние {metrics.online_window_minutes} минут</p>
            </div>
            <div className="rounded-xl border border-gray-200 bg-white p-5 dark:border-[#324467] dark:bg-[#111722]">
              <p className="text-sm text-gray-500 dark:text-[#92a4c9]">Доступ к Remnawave</p>
              <p className="text-2xl font-bold text-cyan-600 dark:text-cyan-400">{metrics.remnawave_access_users}</p>
            </div>
            <div className="rounded-xl border border-gray-200 bg-white p-5 dark:border-[#324467] dark:bg-[#111722]">
              <p className="text-sm text-gray-500 dark:text-[#92a4c9]">Нужна перерегистрация</p>
              <p className="text-2xl font-bold text-red-600 dark:text-red-400">{metrics.users_without_password}</p>
            </div>
            <div className="rounded-xl border border-gray-200 bg-white p-5 dark:border-[#324467] dark:bg-[#111722]">
              <p className="text-sm text-gray-500 dark:text-[#92a4c9]">Активны сегодня</p>
              <p className="text-2xl font-bold text-gray-900 dark:text-white">{metrics.active_today}</p>
            </div>
          </div>

          {error ? <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-600">{error}</div> : null}
          {notice ? <div className="rounded-lg border border-green-200 bg-green-50 px-4 py-3 text-sm text-green-700">{notice}</div> : null}

          <div className="grid grid-cols-1 gap-6 xl:grid-cols-3">
            <section className="rounded-xl border border-gray-200 bg-white p-5 dark:border-[#324467] dark:bg-[#111722] xl:col-span-2">
              <div className="mb-4 flex flex-wrap gap-3">
                <input
                  className="h-10 min-w-[220px] flex-1 rounded-lg border border-gray-300 bg-white px-3 text-sm text-gray-900 outline-none focus:border-primary dark:border-[#324467] dark:bg-[#0d1525] dark:text-white"
                  onChange={(event) => setSearch(event.target.value)}
                  placeholder="Поиск по ID, логину или email"
                  value={search}
                />
                <select
                  className="h-10 rounded-lg border border-gray-300 bg-white px-3 text-sm text-gray-900 outline-none focus:border-primary dark:border-[#324467] dark:bg-[#0d1525] dark:text-white"
                  onChange={(event) => setFilter(event.target.value as UserFilter)}
                  value={filter}
                >
                  <option value="all">Все</option>
                  <option value="online">Только онлайн</option>
                  <option value="remnawave">С доступом Remnawave</option>
                  <option value="need-password">Без пароля</option>
                </select>
              </div>

              {isLoading ? (
                <p className="text-sm text-gray-500 dark:text-[#92a4c9]">Загрузка...</p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="min-w-full">
                    <thead>
                      <tr className="border-b border-gray-200 dark:border-[#324467]">
                        <th className="px-3 py-2 text-left text-sm font-semibold text-gray-700 dark:text-white">Пользователь</th>
                        <th className="px-3 py-2 text-left text-sm font-semibold text-gray-700 dark:text-white">Статус</th>
                        <th className="px-3 py-2 text-left text-sm font-semibold text-gray-700 dark:text-white">Пароль</th>
                        <th className="px-3 py-2 text-left text-sm font-semibold text-gray-700 dark:text-white">Последний вход</th>
                      </tr>
                    </thead>
                    <tbody>
                      {filteredUsers.map((item) => (
                        <tr
                          className={
                            item.id === selectedUserId
                              ? 'cursor-pointer border-b border-gray-100 bg-primary/5 dark:border-[#1e2a40] dark:bg-[#1d2b45]'
                              : 'cursor-pointer border-b border-gray-100 dark:border-[#1e2a40]'
                          }
                          key={item.id}
                          onClick={() => setSelectedUserId(item.id)}
                        >
                          <td className="px-3 py-3">
                            <div className="flex items-center gap-2 text-sm font-medium text-gray-900 dark:text-white">
                              <span>{item.login}</span>
                              {item.has_remnawave_access ? <RemnawaveIcon title="Есть доступ Remnawave" /> : null}
                            </div>
                            <p className="text-xs text-gray-500 dark:text-[#92a4c9]">
                              ID {item.id} • {item.email || 'email не задан'}
                            </p>
                          </td>
                          <td className="px-3 py-3 text-sm">
                            {item.is_online ? (
                              <span className="inline-flex rounded-full bg-green-500/10 px-2 py-1 text-xs font-semibold text-green-600">
                                Онлайн
                              </span>
                            ) : (
                              <span className="inline-flex rounded-full bg-gray-500/10 px-2 py-1 text-xs font-semibold text-gray-600">
                                Не в сети
                              </span>
                            )}
                          </td>
                          <td className="px-3 py-3 text-sm">
                            {item.has_password ? (
                              <span className="inline-flex rounded-full bg-blue-500/10 px-2 py-1 text-xs font-semibold text-blue-600">
                                Установлен
                              </span>
                            ) : (
                              <span className="inline-flex rounded-full bg-red-500/10 px-2 py-1 text-xs font-semibold text-red-600">
                                Сброшен
                              </span>
                            )}
                          </td>
                          <td className="px-3 py-3 text-sm text-gray-600 dark:text-[#92a4c9]">{formatDateTime(item.last_login)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>

            <section className="rounded-xl border border-gray-200 bg-white p-5 dark:border-[#324467] dark:bg-[#111722]">
              {!selectedUser ? (
                <p className="text-sm text-gray-500 dark:text-[#92a4c9]">Выберите пользователя в списке</p>
              ) : (
                <div className="flex flex-col gap-4">
                  <div>
                    <p className="text-xs uppercase tracking-wide text-gray-500 dark:text-[#92a4c9]">Редактор аккаунта</p>
                    <div className="mt-1 flex items-center gap-2 text-lg font-semibold text-gray-900 dark:text-white">
                      <span>{selectedUser.login}</span>
                      {selectedUser.has_remnawave_access ? <RemnawaveIcon title="Есть доступ Remnawave" /> : null}
                    </div>
                    <p className="text-xs text-gray-500 dark:text-[#92a4c9]">ID: {selectedUser.id}</p>
                  </div>

                  <label className="flex flex-col gap-2">
                    <span className="text-sm font-medium text-gray-700 dark:text-white">Логин (email)</span>
                    <input
                      className="h-10 rounded-lg border border-gray-300 bg-white px-3 text-sm text-gray-900 outline-none focus:border-primary dark:border-[#324467] dark:bg-[#0d1525] dark:text-white"
                      onChange={(event) => setEditLogin(event.target.value)}
                      type="email"
                      value={editLogin}
                    />
                  </label>

                  <label className="flex flex-col gap-2">
                    <span className="text-sm font-medium text-gray-700 dark:text-white">Новый пароль</span>
                    <input
                      className="h-10 rounded-lg border border-gray-300 bg-white px-3 text-sm text-gray-900 outline-none focus:border-primary dark:border-[#324467] dark:bg-[#0d1525] dark:text-white"
                      onChange={(event) => setEditPassword(event.target.value)}
                      placeholder="Оставьте пустым, если не менять"
                      type="password"
                      value={editPassword}
                    />
                  </label>

                  <div className="flex flex-col gap-2">
                    <button
                      className="flex h-10 items-center justify-center rounded-lg bg-primary px-3 text-sm font-bold text-white hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-60"
                      disabled={isSaving}
                      onClick={handleSaveCredentials}
                      type="button"
                    >
                      Сохранить логин/пароль
                    </button>
                    <button
                      className="flex h-10 items-center justify-center rounded-lg border border-red-300 px-3 text-sm font-bold text-red-600 hover:bg-red-50 disabled:cursor-not-allowed disabled:opacity-60 dark:border-red-500/40 dark:text-red-400 dark:hover:bg-red-500/10"
                      disabled={isSaving}
                      onClick={handleResetPassword}
                      type="button"
                    >
                      Сбросить и удалить пароль
                    </button>
                  </div>

                  <div className="rounded-lg bg-gray-50 p-3 text-xs text-gray-600 dark:bg-[#0d1525] dark:text-[#92a4c9]">
                    <p>Дата регистрации: {formatDateTime(selectedUser.date_joined)}</p>
                    <p>Последний вход: {formatDateTime(selectedUser.last_login)}</p>
                  </div>

                  {selectedUser.subscription_url ? (
                    <a
                      className="rounded-lg border border-cyan-300 bg-cyan-50 px-3 py-2 text-sm font-medium text-cyan-700 hover:bg-cyan-100 dark:border-cyan-500/40 dark:bg-cyan-500/10 dark:text-cyan-300 dark:hover:bg-cyan-500/20"
                      href={selectedUser.subscription_url}
                      rel="noopener noreferrer"
                      target="_blank"
                    >
                      Открыть ссылку Remnawave
                    </a>
                  ) : (
                    <div className="rounded-lg border border-gray-200 px-3 py-2 text-sm text-gray-500 dark:border-[#324467] dark:text-[#92a4c9]">
                      У пользователя нет ссылки Remnawave
                    </div>
                  )}
                </div>
              )}
            </section>
          </div>
        </div>
      </main>
    </div>
  )
}
