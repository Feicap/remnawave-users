import { useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router'
import { useChatUnreadPing } from '../hooks/useChatUnreadPing'
import type { AuthUser } from '../types/auth'
import type { AdminUserItem, AdminUsersMetrics, AdminUsersResponse, ApiError } from '../types/admin'
import type { ChatMessageItem, ChatScope } from '../types/chat'
import { buildAuthHeaders, clearStoredAuth, getStoredUser, refreshStoredAuthUser } from '../utils/auth'
import { isAdminUser } from '../utils/admin'

const REFRESH_INTERVAL_MS = 30_000
const CHAT_AUDIT_REFRESH_INTERVAL_MS = 12_000

const DEFAULT_METRICS: AdminUsersMetrics = {
  total_users: 0,
  online_users: 0,
  online_window_minutes: 15,
  remnawave_access_users: 0,
  users_without_password: 0,
  active_today: 0,
}

type UserFilter = 'all' | 'online' | 'remnawave' | 'need-password'
type AdminTab = 'users' | 'moderation'

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
    return 'РќРёРєРѕРіРґР°'
  }

  const date = new Date(value)
  if (Number.isNaN(date.getTime())) {
    return 'РќРµРІРµСЂРЅР°СЏ РґР°С‚Р°'
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

function formatChatScope(scope: string): string {
  return scope === 'private' ? 'Р›РёС‡РЅС‹Р№' : 'РћР±С‰РёР№'
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
  const { totalUnread } = useChatUnreadPing(user)
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
  const [activeTab, setActiveTab] = useState<AdminTab>('users')
  const [chatMessages, setChatMessages] = useState<ChatMessageItem[]>([])
  const [chatScopeFilter, setChatScopeFilter] = useState<'all' | ChatScope>('all')
  const [chatUserFilter, setChatUserFilter] = useState('')
  const [chatPeerFilter, setChatPeerFilter] = useState('')
  const [isChatLoading, setIsChatLoading] = useState(false)

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
          setError(await parseApiError(response, 'РќРµ СѓРґР°Р»РѕСЃСЊ Р·Р°РіСЂСѓР·РёС‚СЊ РїРѕР»СЊР·РѕРІР°С‚РµР»РµР№'))
          return
        }

        const payload = (await response.json()) as AdminUsersResponse
        setUsers(payload.items)
        setMetrics(payload.metrics)
        setError('')
      } catch {
        setError('РћС€РёР±РєР° СЃРµС‚Рё РїСЂРё Р·Р°РіСЂСѓР·РєРµ РїРѕР»СЊР·РѕРІР°С‚РµР»РµР№')
      } finally {
        setIsLoading(false)
      }
    },
    [navigate, user],
  )

  const loadAdminChat = useCallback(
    async (showLoader: boolean) => {
      if (!user) {
        return
      }
      if (showLoader) {
        setIsChatLoading(true)
      }

      const query = new URLSearchParams({
        limit: '200',
        scope: chatScopeFilter,
      })
      const trimmedUser = chatUserFilter.trim()
      const trimmedPeer = chatPeerFilter.trim()
      if (trimmedUser) {
        query.set('user_id', trimmedUser)
      }
      if (trimmedPeer) {
        query.set('peer_id', trimmedPeer)
      }

      try {
        const response = await fetch(`/api/admin/chat/messages/?${query.toString()}`, {
          headers: buildAuthHeaders(user),
        })

        if (!response.ok) {
          if (response.status === 401 || response.status === 403) {
            clearStoredAuth()
            navigate('/auth')
            return
          }
          setError(await parseApiError(response, 'РќРµ СѓРґР°Р»РѕСЃСЊ Р·Р°РіСЂСѓР·РёС‚СЊ СЃРѕРѕР±С‰РµРЅРёСЏ С‡Р°С‚Р°'))
          return
        }

        const payload = (await response.json()) as { items: ChatMessageItem[] }
        setChatMessages(payload.items)
      } catch {
        setError('РћС€РёР±РєР° СЃРµС‚Рё РїСЂРё Р·Р°РіСЂСѓР·РєРµ СЃРѕРѕР±С‰РµРЅРёР№ С‡Р°С‚Р°')
      } finally {
        setIsChatLoading(false)
      }
    },
    [chatPeerFilter, chatScopeFilter, chatUserFilter, navigate, user],
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
          setError('РќРµ СѓРґР°Р»РѕСЃСЊ РѕР±РЅРѕРІРёС‚СЊ РїСЂРѕС„РёР»СЊ Р°РґРјРёРЅРёСЃС‚СЂР°С‚РѕСЂР°')
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
      setError('РќРµ СѓРґР°Р»РѕСЃСЊ Р·Р°РіСЂСѓР·РёС‚СЊ РїРѕР»СЊР·РѕРІР°С‚РµР»РµР№')
    })

    const intervalId = window.setInterval(() => {
      loadUsers(false).catch(() => {
        setError('РќРµ СѓРґР°Р»РѕСЃСЊ РѕР±РЅРѕРІРёС‚СЊ РґР°РЅРЅС‹Рµ Р°РґРјРёРЅРєРё')
      })
    }, REFRESH_INTERVAL_MS)

    return () => {
      window.clearInterval(intervalId)
    }
  }, [loadUsers, user])

  useEffect(() => {
    if (!user || !isAdminUser(user) || activeTab !== 'moderation') {
      return
    }

    loadAdminChat(true).catch(() => {
      setError('РќРµ СѓРґР°Р»РѕСЃСЊ Р·Р°РіСЂСѓР·РёС‚СЊ СЃРѕРѕР±С‰РµРЅРёСЏ С‡Р°С‚Р°')
    })

    const intervalId = window.setInterval(() => {
      loadAdminChat(false).catch(() => {
        setError('РќРµ СѓРґР°Р»РѕСЃСЊ РѕР±РЅРѕРІРёС‚СЊ СЃРѕРѕР±С‰РµРЅРёСЏ С‡Р°С‚Р°')
      })
    }, CHAT_AUDIT_REFRESH_INTERVAL_MS)

    return () => {
      window.clearInterval(intervalId)
    }
  }, [activeTab, loadAdminChat, user])

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
      setError('Р›РѕРіРёРЅ РЅРµ РјРѕР¶РµС‚ Р±С‹С‚СЊ РїСѓСЃС‚С‹Рј')
      return
    }
    if (normalizedLogin !== selectedUser.login.toLowerCase()) {
      payload.login = normalizedLogin
    }

    if (editPassword.trim()) {
      payload.password = editPassword
    }

    if (!payload.login && !payload.password) {
      setNotice('РќРµС‚ РёР·РјРµРЅРµРЅРёР№ РґР»СЏ СЃРѕС…СЂР°РЅРµРЅРёСЏ')
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
        setError(await parseApiError(response, 'РќРµ СѓРґР°Р»РѕСЃСЊ РѕР±РЅРѕРІРёС‚СЊ РґР°РЅРЅС‹Рµ РїРѕР»СЊР·РѕРІР°С‚РµР»СЏ'))
        return
      }

      setEditPassword('')
      setNotice('Р”Р°РЅРЅС‹Рµ РїРѕР»СЊР·РѕРІР°С‚РµР»СЏ РѕР±РЅРѕРІР»РµРЅС‹')
      await loadUsers(false)
    } catch {
      setError('РћС€РёР±РєР° СЃРµС‚Рё РїСЂРё СЃРѕС…СЂР°РЅРµРЅРёРё РїРѕР»СЊР·РѕРІР°С‚РµР»СЏ')
    } finally {
      setIsSaving(false)
    }
  }

  async function handleResetPassword() {
    if (!user || !selectedUser) {
      return
    }

    if (!window.confirm(`РЎР±СЂРѕСЃРёС‚СЊ РїР°СЂРѕР»СЊ РґР»СЏ ${selectedUser.login}? РџРѕСЃР»Рµ СЌС‚РѕРіРѕ РїРѕР»СЊР·РѕРІР°С‚РµР»СЊ РґРѕР»Р¶РµРЅ РїСЂРѕР№С‚Рё СЂРµРіРёСЃС‚СЂР°С†РёСЋ Р·Р°РЅРѕРІРѕ.`)) {
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
        setError(await parseApiError(response, 'РќРµ СѓРґР°Р»РѕСЃСЊ СЃР±СЂРѕСЃРёС‚СЊ РїР°СЂРѕР»СЊ РїРѕР»СЊР·РѕРІР°С‚РµР»СЏ'))
        return
      }

      setEditPassword('')
      setNotice('РџР°СЂРѕР»СЊ СѓРґР°Р»С‘РЅ. РџРѕР»СЊР·РѕРІР°С‚РµР»СЊ РґРѕР»Р¶РµРЅ Р·Р°СЂРµРіРёСЃС‚СЂРёСЂРѕРІР°С‚СЊСЃСЏ Р·Р°РЅРѕРІРѕ.')
      await loadUsers(false)
    } catch {
      setError('РћС€РёР±РєР° СЃРµС‚Рё РїСЂРё СЃР±СЂРѕСЃРµ РїР°СЂРѕР»СЏ')
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

  function handleChat() {
    navigate('/chat')
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
              <span className="text-xl font-bold text-gray-900 dark:text-white">РњРѕР№ VPS</span>
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
                    {user.username || 'РђРґРјРёРЅРёСЃС‚СЂР°С‚РѕСЂ'}
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
                  <p className="text-sm font-medium leading-normal text-primary dark:text-white">РђРґРјРёРЅ РїР°РЅРµР»СЊ</p>
                </a>
                <button
                  className="cursor-pointer rounded-lg px-3 py-2 text-left hover:bg-gray-100 dark:hover:bg-gray-800/50"
                  onClick={handlePaymentCheck}
                  type="button"
                >
                  <div className="flex items-center gap-3">
                    <span className="material-symbols-outlined text-gray-500 dark:text-white">credit_card</span>
                    <p className="text-sm font-medium leading-normal text-gray-700 dark:text-white">РџСЂРѕРІРµСЂРєР° РѕРїР»Р°С‚С‹</p>
                  </div>
                </button>
                <button
                  className="cursor-pointer rounded-lg px-3 py-2 text-left hover:bg-gray-100 dark:hover:bg-gray-800/50"
                  onClick={handleChat}
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
                    <p className="text-sm font-medium leading-normal text-gray-700 dark:text-white">РћР±СЂР°С‚РЅРѕ РІ РїСЂРѕС„РёР»СЊ</p>
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
            <span className="truncate">Р’С‹Р№С‚Рё</span>
          </button>
        </div>
      </aside>

      <main className="flex-1 overflow-y-auto p-4 md:p-6 lg:p-10">
        <div className="mx-auto flex max-w-7xl flex-col gap-6">
          <div className="inline-flex rounded-lg border border-gray-200 bg-white p-1 dark:border-[#324467] dark:bg-[#111722]">
            <button
              className={
                activeTab === 'users'
                  ? 'rounded-md bg-primary px-3 py-1.5 text-sm font-semibold text-white'
                  : 'rounded-md px-3 py-1.5 text-sm text-gray-600 hover:bg-gray-100 dark:text-[#92a4c9] dark:hover:bg-[#1a2539]'
              }
              onClick={() => setActiveTab('users')}
              type="button"
            >
              Пользователи
            </button>
            <button
              className={
                activeTab === 'moderation'
                  ? 'rounded-md bg-primary px-3 py-1.5 text-sm font-semibold text-white'
                  : 'rounded-md px-3 py-1.5 text-sm text-gray-600 hover:bg-gray-100 dark:text-[#92a4c9] dark:hover:bg-[#1a2539]'
              }
              onClick={() => setActiveTab('moderation')}
              type="button"
            >
              Модерация
            </button>
          </div>

          {activeTab === 'users' ? (
            <>
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div className="flex flex-col gap-1">
              <p className="text-4xl font-black leading-tight tracking-[-0.033em] text-gray-900 dark:text-white">
                РЈРїСЂР°РІР»РµРЅРёРµ РїРѕР»СЊР·РѕРІР°С‚РµР»СЏРјРё
              </p>
              <p className="text-base font-normal leading-normal text-gray-500 dark:text-[#92a4c9]">
                РћРЅР»Р°Р№РЅ-Р°РєС‚РёРІРЅРѕСЃС‚СЊ, РґРѕСЃС‚СѓРї Remnawave Рё СѓРїСЂР°РІР»РµРЅРёРµ Р°РІС‚РѕСЂРёР·Р°С†РёРµР№ Р°РєРєР°СѓРЅС‚РѕРІ.
              </p>
            </div>
            <button
              className="flex h-10 min-w-[84px] cursor-pointer items-center justify-center gap-2 overflow-hidden rounded-lg bg-primary px-4 text-sm font-bold leading-normal tracking-[0.015em] text-white hover:bg-primary/90"
              onClick={() => {
                loadUsers(true).catch(() => {
                  setError('РќРµ СѓРґР°Р»РѕСЃСЊ РѕР±РЅРѕРІРёС‚СЊ РїРѕР»СЊР·РѕРІР°С‚РµР»РµР№')
                })
              }}
              type="button"
            >
              <span className="material-symbols-outlined text-base">refresh</span>
              <span className="truncate">РћР±РЅРѕРІРёС‚СЊ</span>
            </button>
          </div>

          <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-5">
            <div className="rounded-xl border border-gray-200 bg-white p-5 dark:border-[#324467] dark:bg-[#111722]">
              <p className="text-sm text-gray-500 dark:text-[#92a4c9]">Р’СЃРµРіРѕ Р°РєРєР°СѓРЅС‚РѕРІ</p>
              <p className="text-2xl font-bold text-gray-900 dark:text-white">{metrics.total_users}</p>
            </div>
            <div className="rounded-xl border border-gray-200 bg-white p-5 dark:border-[#324467] dark:bg-[#111722]">
              <p className="text-sm text-gray-500 dark:text-[#92a4c9]">РћРЅР»Р°Р№РЅ РЅР° СЃР°Р№С‚Рµ</p>
              <p className="text-2xl font-bold text-green-600 dark:text-green-400">{metrics.online_users}</p>
              <p className="text-xs text-gray-500 dark:text-[#92a4c9]">Р—Р° РїРѕСЃР»РµРґРЅРёРµ {metrics.online_window_minutes} РјРёРЅСѓС‚</p>
            </div>
            <div className="rounded-xl border border-gray-200 bg-white p-5 dark:border-[#324467] dark:bg-[#111722]">
              <p className="text-sm text-gray-500 dark:text-[#92a4c9]">Р”РѕСЃС‚СѓРї Рє Remnawave</p>
              <p className="text-2xl font-bold text-cyan-600 dark:text-cyan-400">{metrics.remnawave_access_users}</p>
            </div>
            <div className="rounded-xl border border-gray-200 bg-white p-5 dark:border-[#324467] dark:bg-[#111722]">
              <p className="text-sm text-gray-500 dark:text-[#92a4c9]">РќСѓР¶РЅР° РїРµСЂРµСЂРµРіРёСЃС‚СЂР°С†РёСЏ</p>
              <p className="text-2xl font-bold text-red-600 dark:text-red-400">{metrics.users_without_password}</p>
            </div>
            <div className="rounded-xl border border-gray-200 bg-white p-5 dark:border-[#324467] dark:bg-[#111722]">
              <p className="text-sm text-gray-500 dark:text-[#92a4c9]">РђРєС‚РёРІРЅС‹ СЃРµРіРѕРґРЅСЏ</p>
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
                  placeholder="РџРѕРёСЃРє РїРѕ ID, Р»РѕРіРёРЅСѓ РёР»Рё email"
                  value={search}
                />
                <select
                  className="h-10 rounded-lg border border-gray-300 bg-white px-3 text-sm text-gray-900 outline-none focus:border-primary dark:border-[#324467] dark:bg-[#0d1525] dark:text-white"
                  onChange={(event) => setFilter(event.target.value as UserFilter)}
                  value={filter}
                >
                  <option value="all">Р’СЃРµ</option>
                  <option value="online">РўРѕР»СЊРєРѕ РѕРЅР»Р°Р№РЅ</option>
                  <option value="remnawave">РЎ РґРѕСЃС‚СѓРїРѕРј Remnawave</option>
                  <option value="need-password">Р‘РµР· РїР°СЂРѕР»СЏ</option>
                </select>
              </div>

              {isLoading ? (
                <p className="text-sm text-gray-500 dark:text-[#92a4c9]">Р—Р°РіСЂСѓР·РєР°...</p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="min-w-full">
                    <thead>
                      <tr className="border-b border-gray-200 dark:border-[#324467]">
                        <th className="px-3 py-2 text-left text-sm font-semibold text-gray-700 dark:text-white">РџРѕР»СЊР·РѕРІР°С‚РµР»СЊ</th>
                        <th className="px-3 py-2 text-left text-sm font-semibold text-gray-700 dark:text-white">РЎС‚Р°С‚СѓСЃ</th>
                        <th className="px-3 py-2 text-left text-sm font-semibold text-gray-700 dark:text-white">РџР°СЂРѕР»СЊ</th>
                        <th className="px-3 py-2 text-left text-sm font-semibold text-gray-700 dark:text-white">РџРѕСЃР»РµРґРЅРёР№ РІС…РѕРґ</th>
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
                              {item.has_remnawave_access ? <RemnawaveIcon title="Р•СЃС‚СЊ РґРѕСЃС‚СѓРї Remnawave" /> : null}
                            </div>
                            <p className="text-xs text-gray-500 dark:text-[#92a4c9]">
                              ID {item.id} вЂў {item.email || 'email РЅРµ Р·Р°РґР°РЅ'}
                            </p>
                          </td>
                          <td className="px-3 py-3 text-sm">
                            {item.is_online ? (
                              <span className="inline-flex rounded-full bg-green-500/10 px-2 py-1 text-xs font-semibold text-green-600">
                                РћРЅР»Р°Р№РЅ
                              </span>
                            ) : (
                              <span className="inline-flex rounded-full bg-gray-500/10 px-2 py-1 text-xs font-semibold text-gray-600">
                                РќРµ РІ СЃРµС‚Рё
                              </span>
                            )}
                          </td>
                          <td className="px-3 py-3 text-sm">
                            {item.has_password ? (
                              <span className="inline-flex rounded-full bg-blue-500/10 px-2 py-1 text-xs font-semibold text-blue-600">
                                РЈСЃС‚Р°РЅРѕРІР»РµРЅ
                              </span>
                            ) : (
                              <span className="inline-flex rounded-full bg-red-500/10 px-2 py-1 text-xs font-semibold text-red-600">
                                РЎР±СЂРѕС€РµРЅ
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
                <p className="text-sm text-gray-500 dark:text-[#92a4c9]">Р’С‹Р±РµСЂРёС‚Рµ РїРѕР»СЊР·РѕРІР°С‚РµР»СЏ РІ СЃРїРёСЃРєРµ</p>
              ) : (
                <div className="flex flex-col gap-4">
                  <div>
                    <p className="text-xs uppercase tracking-wide text-gray-500 dark:text-[#92a4c9]">Р РµРґР°РєС‚РѕСЂ Р°РєРєР°СѓРЅС‚Р°</p>
                    <div className="mt-1 flex items-center gap-2 text-lg font-semibold text-gray-900 dark:text-white">
                      <span>{selectedUser.login}</span>
                      {selectedUser.has_remnawave_access ? <RemnawaveIcon title="Р•СЃС‚СЊ РґРѕСЃС‚СѓРї Remnawave" /> : null}
                    </div>
                    <p className="text-xs text-gray-500 dark:text-[#92a4c9]">ID: {selectedUser.id}</p>
                  </div>

                  <label className="flex flex-col gap-2">
                    <span className="text-sm font-medium text-gray-700 dark:text-white">Р›РѕРіРёРЅ (email)</span>
                    <input
                      className="h-10 rounded-lg border border-gray-300 bg-white px-3 text-sm text-gray-900 outline-none focus:border-primary dark:border-[#324467] dark:bg-[#0d1525] dark:text-white"
                      onChange={(event) => setEditLogin(event.target.value)}
                      type="email"
                      value={editLogin}
                    />
                  </label>

                  <label className="flex flex-col gap-2">
                    <span className="text-sm font-medium text-gray-700 dark:text-white">РќРѕРІС‹Р№ РїР°СЂРѕР»СЊ</span>
                    <input
                      className="h-10 rounded-lg border border-gray-300 bg-white px-3 text-sm text-gray-900 outline-none focus:border-primary dark:border-[#324467] dark:bg-[#0d1525] dark:text-white"
                      onChange={(event) => setEditPassword(event.target.value)}
                      placeholder="РћСЃС‚Р°РІСЊС‚Рµ РїСѓСЃС‚С‹Рј, РµСЃР»Рё РЅРµ РјРµРЅСЏС‚СЊ"
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
                      РЎРѕС…СЂР°РЅРёС‚СЊ Р»РѕРіРёРЅ/РїР°СЂРѕР»СЊ
                    </button>
                    <button
                      className="flex h-10 items-center justify-center rounded-lg border border-red-300 px-3 text-sm font-bold text-red-600 hover:bg-red-50 disabled:cursor-not-allowed disabled:opacity-60 dark:border-red-500/40 dark:text-red-400 dark:hover:bg-red-500/10"
                      disabled={isSaving}
                      onClick={handleResetPassword}
                      type="button"
                    >
                      РЎР±СЂРѕСЃРёС‚СЊ Рё СѓРґР°Р»РёС‚СЊ РїР°СЂРѕР»СЊ
                    </button>
                  </div>

                  <div className="rounded-lg bg-gray-50 p-3 text-xs text-gray-600 dark:bg-[#0d1525] dark:text-[#92a4c9]">
                    <p>Р”Р°С‚Р° СЂРµРіРёСЃС‚СЂР°С†РёРё: {formatDateTime(selectedUser.date_joined)}</p>
                    <p>РџРѕСЃР»РµРґРЅРёР№ РІС…РѕРґ: {formatDateTime(selectedUser.last_login)}</p>
                  </div>

                  {selectedUser.subscription_url ? (
                    <a
                      className="rounded-lg border border-cyan-300 bg-cyan-50 px-3 py-2 text-sm font-medium text-cyan-700 hover:bg-cyan-100 dark:border-cyan-500/40 dark:bg-cyan-500/10 dark:text-cyan-300 dark:hover:bg-cyan-500/20"
                      href={selectedUser.subscription_url}
                      rel="noopener noreferrer"
                      target="_blank"
                    >
                      РћС‚РєСЂС‹С‚СЊ СЃСЃС‹Р»РєСѓ Remnawave
                    </a>
                  ) : (
                    <div className="rounded-lg border border-gray-200 px-3 py-2 text-sm text-gray-500 dark:border-[#324467] dark:text-[#92a4c9]">
                      РЈ РїРѕР»СЊР·РѕРІР°С‚РµР»СЏ РЅРµС‚ СЃСЃС‹Р»РєРё Remnawave
                    </div>
                  )}
                </div>
              )}
            </section>
          </div>
            </>
          ) : (
            <section className="rounded-xl border border-gray-200 bg-white p-5 dark:border-[#324467] dark:bg-[#111722]">
              <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
                <div>
                  <p className="text-lg font-bold text-gray-900 dark:text-white">Модерация чата</p>
                  <p className="text-sm text-gray-500 dark:text-[#92a4c9]">Просмотр всех сообщений, включая личные.</p>
                </div>
                <button
                  className="rounded-lg border border-gray-300 px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-50 dark:border-[#324467] dark:text-white dark:hover:bg-[#1a2539]"
                  onClick={() => {
                    loadAdminChat(true).catch(() => {
                      setError('Не удалось обновить сообщения чата')
                    })
                  }}
                  type="button"
                >
                  Обновить чат
                </button>
              </div>

              {error ? <div className="mb-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-600">{error}</div> : null}

              <div className="mb-4 grid grid-cols-1 gap-3 md:grid-cols-4">
                <select
                  className="h-10 rounded-lg border border-gray-300 bg-white px-3 text-sm text-gray-900 outline-none focus:border-primary dark:border-[#324467] dark:bg-[#0d1525] dark:text-white"
                  onChange={(event) => setChatScopeFilter(event.target.value as 'all' | ChatScope)}
                  value={chatScopeFilter}
                >
                  <option value="all">Все типы</option>
                  <option value="global">Только общий</option>
                  <option value="private">Только личные</option>
                </select>
                <input
                  className="h-10 rounded-lg border border-gray-300 bg-white px-3 text-sm text-gray-900 outline-none focus:border-primary dark:border-[#324467] dark:bg-[#0d1525] dark:text-white"
                  onChange={(event) => setChatUserFilter(event.target.value)}
                  placeholder="Фильтр user_id"
                  value={chatUserFilter}
                />
                <input
                  className="h-10 rounded-lg border border-gray-300 bg-white px-3 text-sm text-gray-900 outline-none focus:border-primary dark:border-[#324467] dark:bg-[#0d1525] dark:text-white"
                  onChange={(event) => setChatPeerFilter(event.target.value)}
                  placeholder="Фильтр peer_id"
                  value={chatPeerFilter}
                />
                <button
                  className="h-10 rounded-lg bg-primary px-3 text-sm font-semibold text-white hover:bg-primary/90"
                  onClick={() => {
                    loadAdminChat(true).catch(() => {
                      setError('Не удалось обновить сообщения чата')
                    })
                  }}
                  type="button"
                >
                  Применить фильтр
                </button>
              </div>

              {isChatLoading ? (
                <p className="text-sm text-gray-500 dark:text-[#92a4c9]">Загрузка сообщений...</p>
              ) : chatMessages.length === 0 ? (
                <p className="text-sm text-gray-500 dark:text-[#92a4c9]">По выбранным фильтрам сообщений нет.</p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="min-w-full">
                    <thead>
                      <tr className="border-b border-gray-200 dark:border-[#324467]">
                        <th className="px-3 py-2 text-left text-sm font-semibold text-gray-700 dark:text-white">Время</th>
                        <th className="px-3 py-2 text-left text-sm font-semibold text-gray-700 dark:text-white">Тип</th>
                        <th className="px-3 py-2 text-left text-sm font-semibold text-gray-700 dark:text-white">От</th>
                        <th className="px-3 py-2 text-left text-sm font-semibold text-gray-700 dark:text-white">Кому</th>
                        <th className="px-3 py-2 text-left text-sm font-semibold text-gray-700 dark:text-white">Сообщение</th>
                      </tr>
                    </thead>
                    <tbody>
                      {chatMessages.map((message) => (
                        <tr className="border-b border-gray-100 align-top dark:border-[#1e2a40]" key={message.id}>
                          <td className="px-3 py-2 text-xs text-gray-600 dark:text-[#92a4c9]">{formatDateTime(message.created_at)}</td>
                          <td className="px-3 py-2 text-sm text-gray-700 dark:text-white">{formatChatScope(message.scope)}</td>
                          <td className="px-3 py-2 text-sm text-gray-700 dark:text-white">
                            {message.sender_username} ({message.sender_id})
                          </td>
                          <td className="px-3 py-2 text-sm text-gray-700 dark:text-white">
                            {message.scope === 'global'
                              ? 'Все'
                              : `${message.recipient_username || 'user'} (${message.recipient_id ?? '-'})`}
                          </td>
                          <td className="px-3 py-2 text-sm text-gray-700 dark:text-white">
                            <p className="max-w-[520px] whitespace-pre-wrap break-words">{message.body}</p>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>
          )}
        </div>
      </main>
    </div>
  )
}

