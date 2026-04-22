import type { FormEvent, SyntheticEvent } from 'react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router'
import { useChatRealtime, type ChatRealtimeEvent } from '../hooks/useChatRealtime'
import { useChatUnreadPing } from '../hooks/useChatUnreadPing'
import type { AuthUser } from '../types/auth'
import type { ChatMessageItem, ChatMessagesResponse, ChatScope, ChatUserItem } from '../types/chat'
import { isAdminUser } from '../utils/admin'
import { buildAuthHeaders, clearStoredAuth, getStoredUser, refreshStoredAuthUser, withStoredAvatarVersion } from '../utils/auth'
import { getAvatarImageStyle } from '../utils/avatar'

const DEFAULT_AVATAR =
  'https://lh3.googleusercontent.com/aida-public/AB6AXuD7QfEnuqRCntNYH9h2Vpo3jzR2BMfMqxHuHq-ivlguZcwzF_lfmadLZHf4vT8CfrKoIUNDPR1MmHqWK_suVK1pQOJXx0sSYBdAc3HCdZbWyuwNnuAj95xWWZilTRSMiKUfTt-6lFPSIvaV577Wik1oYO_ONDLJYuA5yaDJJSU7PwQfDQftZAILVh17O3KQr1s3dq56Z1g5mUvalbeTkomtJfUowYTnX-9km8Hdzb5Wm8IyfcVbawTAHqT3EkFdUrXJHLDkkTopp-E'
const REALTIME_REFRESH_DEBOUNCE_MS = 180
const FALLBACK_SYNC_INTERVAL_MS = 45_000

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

function getUserDisplayName(user: AuthUser): string {
  return user.display_name || user.username || user.telegram_username || user.email || `ID ${user.id}`
}

function getPeerDisplayName(peer: ChatUserItem): string {
  return peer.username || peer.telegram_username || peer.email || `ID ${peer.user_id}`
}

function formatMessageTime(value: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) {
    return value
  }
  return date.toLocaleString('ru-RU', {
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })
}

function buildClientMessageId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
}

function getDeliveryLabel(message: ChatMessageItem, isMine: boolean): string {
  if (!isMine || message.scope !== 'private') {
    return ''
  }
  if (message.read_by_recipient) {
    return 'Прочитано'
  }
  if (message.delivered_to_recipient) {
    return 'Доставлено'
  }
  return 'Отправлено'
}

async function parseApiError(response: Response, fallback: string): Promise<string> {
  const payload = (await response.json().catch(() => null)) as { error?: string } | null
  return payload?.error || fallback
}

function parseOptionalNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value
  }
  if (typeof value === 'string') {
    const normalized = Number(value)
    if (Number.isFinite(normalized)) {
      return normalized
    }
  }
  return null
}

export default function Chat() {
  const navigate = useNavigate()
  const [user, setUser] = useState<AuthUser | null>(() => getStoredUser())
  const [scope, setScope] = useState<ChatScope>('global')
  const [users, setUsers] = useState<ChatUserItem[]>([])
  const [selectedPeerId, setSelectedPeerId] = useState<number | null>(null)
  const [messages, setMessages] = useState<ChatMessageItem[]>([])
  const [messageText, setMessageText] = useState('')
  const [messageSearch, setMessageSearch] = useState('')
  const [userSearch, setUserSearch] = useState('')
  const [editingMessageId, setEditingMessageId] = useState<number | null>(null)
  const [editingText, setEditingText] = useState('')
  const [isLoadingUsers, setIsLoadingUsers] = useState(true)
  const [isLoadingMessages, setIsLoadingMessages] = useState(true)
  const [isSending, setIsSending] = useState(false)
  const [isLoadingOlder, setIsLoadingOlder] = useState(false)
  const [hasMoreMessages, setHasMoreMessages] = useState(false)
  const [nextBeforeId, setNextBeforeId] = useState<number | null>(null)
  const [error, setError] = useState('')
  const messagesEndRef = useRef<HTMLDivElement | null>(null)
  const refreshTimerRef = useRef<number | null>(null)
  const pendingUsersRefreshRef = useRef(false)
  const pendingMessagesRefreshRef = useRef(false)
  const { totalUnread } = useChatUnreadPing(user)

  const selectedPeer = useMemo(
    () => users.find((item) => item.user_id === selectedPeerId) ?? null,
    [selectedPeerId, users],
  )
  const canViewAdminPanel = useMemo(() => (user ? isAdminUser(user) : false), [user])
  const filteredUsers = useMemo(() => {
    const search = userSearch.trim().toLowerCase()
    if (!search) {
      return users
    }
    return users.filter((item) => {
      const target = `${item.user_id} ${item.username} ${item.telegram_username} ${item.email}`.toLowerCase()
      return target.includes(search)
    })
  }, [userSearch, users])
  const avatarByUserId = useMemo(() => {
    const mapping = new Map<number, string>()
    if (user) {
      mapping.set(user.id, getAvatarUrl(user.photo))
    }
    for (const item of users) {
      mapping.set(item.user_id, getAvatarUrl(item.photo))
    }
    return mapping
  }, [user, users])

  const handleUnauthorized = useCallback(() => {
    clearStoredAuth()
    navigate('/auth')
  }, [navigate])

  const loadChatUsers = useCallback(async (showLoader: boolean = true) => {
    if (!user) {
      return
    }
    if (showLoader) {
      setIsLoadingUsers(true)
    }
    try {
      const response = await fetch('/api/chat/users/', {
        headers: buildAuthHeaders(user),
      })
      if (response.status === 401 || response.status === 403) {
        handleUnauthorized()
        return
      }
      if (!response.ok) {
        setError(await parseApiError(response, 'Не удалось загрузить пользователей чата'))
        return
      }
      const payload = (await response.json()) as { items: ChatUserItem[] }
      setUsers(payload.items)
      setError('')
    } catch {
      setError('Ошибка сети при загрузке пользователей чата')
    } finally {
      if (showLoader) {
        setIsLoadingUsers(false)
      }
    }
  }, [handleUnauthorized, user])

  const loadMessages = useCallback(
    async (params?: { appendOlder?: boolean; beforeId?: number | null; silent?: boolean }) => {
      if (!user) {
        return
      }
      const appendOlder = Boolean(params?.appendOlder)
      const silent = Boolean(params?.silent) && !appendOlder

      if (scope === 'private' && selectedPeerId === null) {
        setMessages([])
        setHasMoreMessages(false)
        setNextBeforeId(null)
        if (!silent) {
          setIsLoadingMessages(false)
        }
        return
      }

      if (appendOlder) {
        setIsLoadingOlder(true)
      } else if (!silent) {
        setIsLoadingMessages(true)
      }

      const query = new URLSearchParams({ scope, limit: '60' })
      if (scope === 'private' && selectedPeerId !== null) {
        query.set('peer_id', String(selectedPeerId))
      }
      if (messageSearch.trim()) {
        query.set('q', messageSearch.trim())
      }
      if (appendOlder && params?.beforeId !== null && typeof params?.beforeId === 'number') {
        query.set('before_id', String(params.beforeId))
      }

      try {
        const response = await fetch(`/api/chat/messages/?${query.toString()}`, {
          headers: buildAuthHeaders(user),
        })
        if (response.status === 401 || response.status === 403) {
          handleUnauthorized()
          return
        }
        if (!response.ok) {
          setError(await parseApiError(response, 'Не удалось загрузить сообщения'))
          return
        }
        const payload = (await response.json()) as ChatMessagesResponse
        setHasMoreMessages(payload.pagination.has_more)
        setNextBeforeId(payload.pagination.next_before_id)
        setMessages((previous) => (appendOlder ? [...payload.items, ...previous] : payload.items))
        setError('')
      } catch {
        setError('Ошибка сети при загрузке сообщений')
      } finally {
        if (appendOlder) {
          setIsLoadingOlder(false)
        } else if (!silent) {
          setIsLoadingMessages(false)
        }
      }
    },
    [handleUnauthorized, messageSearch, scope, selectedPeerId, user],
  )

  const scheduleRealtimeRefresh = useCallback(
    (target: { users?: boolean; messages?: boolean }) => {
      if (target.users) {
        pendingUsersRefreshRef.current = true
      }
      if (target.messages) {
        pendingMessagesRefreshRef.current = true
      }
      if (refreshTimerRef.current !== null) {
        return
      }

      refreshTimerRef.current = window.setTimeout(() => {
        refreshTimerRef.current = null

        const shouldRefreshUsers = pendingUsersRefreshRef.current
        const shouldRefreshMessages = pendingMessagesRefreshRef.current
        pendingUsersRefreshRef.current = false
        pendingMessagesRefreshRef.current = false

        const tasks: Promise<void>[] = []
        if (shouldRefreshUsers) {
          tasks.push(loadChatUsers(false))
        }
        if (shouldRefreshMessages) {
          tasks.push(loadMessages({ appendOlder: false, silent: true }))
        }

        if (tasks.length > 0) {
          void Promise.all(tasks).catch(() => {
            // Ignore temporary realtime refresh errors.
          })
        }
      }, REALTIME_REFRESH_DEBOUNCE_MS)
    },
    [loadChatUsers, loadMessages],
  )

  const handleRealtimeEvent = useCallback(
    (event: ChatRealtimeEvent) => {
      if (!user) {
        return
      }

      if (event.scope === 'global') {
        if (scope === 'global') {
          scheduleRealtimeRefresh({ messages: true })
        }
        return
      }

      if (event.scope !== 'private') {
        return
      }

      const senderId = parseOptionalNumber(event.sender_id)
      const recipientId = parseOptionalNumber(event.recipient_id)
      const participants = [senderId, recipientId].filter((item): item is number => item !== null)
      const isCurrentDialog =
        scope === 'private' &&
        selectedPeerId !== null &&
        participants.includes(user.id) &&
        participants.includes(selectedPeerId)

      scheduleRealtimeRefresh({ users: true, messages: isCurrentDialog })
    },
    [scheduleRealtimeRefresh, scope, selectedPeerId, user],
  )

  useChatRealtime(user, true, handleRealtimeEvent)

  useEffect(() => {
    if (!user) {
      navigate('/auth')
      return
    }

    let isCancelled = false
    refreshStoredAuthUser(user)
      .then((nextUser) => {
        if (!isCancelled) {
          setUser(nextUser)
        }
      })
      .catch(() => {
        if (!isCancelled) {
          setError('Не удалось обновить профиль пользователя')
        }
      })

    return () => {
      isCancelled = true
    }
  }, [navigate, user?.id])

  useEffect(() => {
    if (!user) {
      return
    }
    loadChatUsers(true).catch(() => {
      setError('Не удалось загрузить пользователей чата')
    })

  }, [loadChatUsers, user])

  useEffect(() => {
    if (scope !== 'private') {
      return
    }
    if (users.length === 0) {
      setSelectedPeerId(null)
      return
    }
    setSelectedPeerId((previousId) => {
      if (previousId !== null && users.some((item) => item.user_id === previousId)) {
        return previousId
      }
      return users[0].user_id
    })
  }, [scope, users])

  useEffect(() => {
    if (!user) {
      return
    }
    setNextBeforeId(null)
    loadMessages({ appendOlder: false }).catch(() => {
      setError('Не удалось загрузить сообщения')
    })

  }, [loadMessages, user])

  useEffect(() => {
    if (!user) {
      return
    }

    const intervalId = window.setInterval(() => {
      void Promise.all([loadChatUsers(false), loadMessages({ appendOlder: false, silent: true })]).catch(() => {
        // Ignore temporary fallback sync errors.
      })
    }, FALLBACK_SYNC_INTERVAL_MS)

    return () => {
      window.clearInterval(intervalId)
    }
  }, [loadChatUsers, loadMessages, user])

  useEffect(() => {
    return () => {
      if (refreshTimerRef.current !== null) {
        window.clearTimeout(refreshTimerRef.current)
      }
    }
  }, [])

  useEffect(() => {
    if (editingMessageId !== null && !messages.some((item) => item.id === editingMessageId)) {
      setEditingMessageId(null)
      setEditingText('')
    }
  }, [editingMessageId, messages])

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages.length, scope, selectedPeerId])

  if (!user) {
    return <div>Loading...</div>
  }

  const avatarUrl = getAvatarUrl(user.photo)
  const displayName = getUserDisplayName(user)
  const telegramId = typeof user.telegram_id === 'number' ? user.telegram_id : null
  const avatarImageStyle = getAvatarImageStyle(user)

  async function handleSendMessage(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!user) {
      return
    }
    const text = messageText.trim()
    if (!text) {
      return
    }
    if (scope === 'private' && selectedPeerId === null) {
      setError('Выберите пользователя для личного чата')
      return
    }

    setIsSending(true)
    setError('')
    try {
      const payload: Record<string, string | number> = {
        scope,
        body: text,
        client_message_id: buildClientMessageId(),
      }
      if (scope === 'private' && selectedPeerId !== null) {
        payload.recipient_id = selectedPeerId
      }
      const response = await fetch('/api/chat/messages/', {
        method: 'POST',
        headers: {
          ...buildAuthHeaders(user),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
      })
      if (response.status === 401 || response.status === 403) {
        handleUnauthorized()
        return
      }
      if (!response.ok) {
        setError(await parseApiError(response, 'Не удалось отправить сообщение'))
        return
      }
      setMessageText('')
      await Promise.all([loadMessages({ appendOlder: false, silent: true }), loadChatUsers(false)])
    } catch {
      setError('Ошибка сети при отправке сообщения')
    } finally {
      setIsSending(false)
    }
  }

  async function handleStartEdit(message: ChatMessageItem) {
    setEditingMessageId(message.id)
    setEditingText(message.body)
  }

  async function handleSaveEdit(messageId: number) {
    if (!user) {
      return
    }
    const body = editingText.trim()
    if (!body) {
      setError('Текст сообщения не может быть пустым')
      return
    }
    try {
      const response = await fetch(`/api/chat/messages/${messageId}/`, {
        method: 'PATCH',
        headers: {
          ...buildAuthHeaders(user),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ body }),
      })
      if (response.status === 401 || response.status === 403) {
        handleUnauthorized()
        return
      }
      if (!response.ok) {
        setError(await parseApiError(response, 'Не удалось обновить сообщение'))
        return
      }
      setEditingMessageId(null)
      setEditingText('')
      await loadMessages({ appendOlder: false, silent: true })
    } catch {
      setError('Ошибка сети при редактировании сообщения')
    }
  }

  async function handleDeleteMessage(messageId: number) {
    if (!user) {
      return
    }
    try {
      const response = await fetch(`/api/chat/messages/${messageId}/`, {
        method: 'DELETE',
        headers: buildAuthHeaders(user),
      })
      if (response.status === 401 || response.status === 403) {
        handleUnauthorized()
        return
      }
      if (!response.ok) {
        setError(await parseApiError(response, 'Не удалось удалить сообщение'))
        return
      }
      await loadMessages({ appendOlder: false, silent: true })
    } catch {
      setError('Ошибка сети при удалении сообщения')
    }
  }

  function handleLogout() {
    clearStoredAuth()
    navigate('/auth')
  }

  function handleGoProfile() {
    navigate('/profile')
  }

  function handleGoPayment() {
    navigate('/profile-pay')
  }

  function handleGoProfileSettings() {
    navigate('/profile-settings')
  }

  function handleGoAdmin() {
    navigate('/admin')
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
                    style={avatarImageStyle}
                  />
                </div>
                <div className="flex flex-col">
                  <h1 className="text-base font-medium leading-normal text-gray-900 dark:text-white">{displayName}</h1>
                  {user.email ? (
                    <p className="text-sm font-normal leading-normal text-gray-500 dark:text-[#92a4c9]">{user.email}</p>
                  ) : null}
                  {telegramId !== null ? (
                    <p className="text-sm font-normal leading-normal text-gray-500 dark:text-[#92a4c9]">Telegram ID: {telegramId}</p>
                  ) : null}
                </div>
              </div>
              <nav className="flex flex-col gap-2">
                <button
                  className="cursor-pointer rounded-lg px-3 py-2 text-left hover:bg-gray-100 dark:hover:bg-gray-800/50"
                  onClick={handleGoProfile}
                  type="button"
                >
                  <div className="flex items-center gap-3">
                    <span className="material-symbols-outlined text-gray-500 dark:text-white">dashboard</span>
                    <p className="text-sm font-medium leading-normal text-gray-700 dark:text-white">Панель управления</p>
                  </div>
                </button>
                <a className="flex items-center gap-3 rounded-lg bg-primary/10 px-3 py-2 dark:bg-[#232f48]" href="#">
                  <div className="relative inline-flex items-center">
                    <span className="material-symbols-outlined text-primary dark:text-white">chat</span>
                    {totalUnread > 0 ? (
                      <span className="absolute -right-2 -top-1 inline-flex min-w-4 items-center justify-center rounded-full bg-red-500 px-1 text-[10px] font-semibold text-white">
                        {totalUnread > 99 ? '99+' : totalUnread}
                      </span>
                    ) : null}
                  </div>
                  <p className="text-sm font-medium leading-normal text-primary dark:text-white">Чат</p>
                </a>
                <button
                  className="cursor-pointer rounded-lg px-3 py-2 text-left hover:bg-gray-100 dark:hover:bg-gray-800/50"
                  onClick={handleGoProfileSettings}
                  type="button"
                >
                  <div className="flex items-center gap-3">
                    <span className="material-symbols-outlined text-gray-500 dark:text-white">manage_accounts</span>
                    <p className="text-sm font-medium leading-normal text-gray-700 dark:text-white">Настройки профиля</p>
                  </div>
                </button>
                <button
                  className="cursor-pointer rounded-lg px-3 py-2 text-left hover:bg-gray-100 dark:hover:bg-gray-800/50"
                  onClick={handleGoPayment}
                  type="button"
                >
                  <div className="flex items-center gap-3">
                    <span className="material-symbols-outlined text-gray-500 dark:text-white">payment</span>
                    <p className="text-sm font-medium leading-normal text-gray-700 dark:text-white">Оплата</p>
                  </div>
                </button>
                {canViewAdminPanel ? (
                  <button
                    className="cursor-pointer rounded-lg px-3 py-2 text-left hover:bg-gray-100 dark:hover:bg-gray-800/50"
                    onClick={handleGoAdmin}
                    type="button"
                  >
                    <div className="flex items-center gap-3">
                      <span className="material-symbols-outlined text-gray-500 dark:text-white">admin_panel_settings</span>
                      <p className="text-sm font-medium leading-normal text-gray-700 dark:text-white">Админ панель</p>
                    </div>
                  </button>
                ) : null}
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
        <div className="mx-auto flex h-full max-w-7xl flex-col gap-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <p className="text-3xl font-black leading-tight tracking-[-0.02em] text-gray-900 dark:text-white">Чат</p>
              <p className="text-sm text-gray-500 dark:text-[#92a4c9]">Общий канал, личные сообщения, поиск и история.</p>
            </div>
            <div className="inline-flex rounded-lg border border-gray-200 bg-white p-1 dark:border-[#324467] dark:bg-[#111722]">
              <button
                className={
                  scope === 'global'
                    ? 'rounded-md bg-primary px-3 py-1.5 text-sm font-semibold text-white'
                    : 'rounded-md px-3 py-1.5 text-sm text-gray-600 hover:bg-gray-100 dark:text-[#92a4c9] dark:hover:bg-[#1a2539]'
                }
                onClick={() => setScope('global')}
                type="button"
              >
                Общий чат
              </button>
              <button
                className={
                  scope === 'private'
                    ? 'rounded-md bg-primary px-3 py-1.5 text-sm font-semibold text-white'
                    : 'rounded-md px-3 py-1.5 text-sm text-gray-600 hover:bg-gray-100 dark:text-[#92a4c9] dark:hover:bg-[#1a2539]'
                }
                onClick={() => setScope('private')}
                type="button"
              >
                Личные
              </button>
            </div>
          </div>

          {error ? <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-2 text-sm text-red-700">{error}</div> : null}

          <div className={scope === 'private' ? 'grid flex-1 grid-cols-1 gap-4 xl:grid-cols-4' : 'flex flex-1 flex-col'}>
            {scope === 'private' ? (
              <section className="rounded-xl border border-gray-200 bg-white p-3 dark:border-[#324467] dark:bg-[#111722]">
                <p className="mb-2 text-sm font-semibold text-gray-900 dark:text-white">Пользователи</p>
                <input
                  className="mb-3 h-9 w-full rounded-lg border border-gray-300 bg-white px-3 text-sm text-gray-900 outline-none focus:border-primary dark:border-[#324467] dark:bg-[#0f1728] dark:text-white"
                  onChange={(event) => setUserSearch(event.target.value)}
                  placeholder="Поиск пользователя"
                  value={userSearch}
                />
                {isLoadingUsers ? (
                  <p className="text-sm text-gray-500 dark:text-[#92a4c9]">Загрузка...</p>
                ) : filteredUsers.length === 0 ? (
                  <p className="text-sm text-gray-500 dark:text-[#92a4c9]">Пользователи не найдены.</p>
                ) : (
                  <div className="flex max-h-[60vh] flex-col gap-2 overflow-y-auto">
                    {filteredUsers.map((item) => (
                      <button
                        className={
                          selectedPeerId === item.user_id
                            ? 'rounded-lg border border-primary bg-primary/10 px-3 py-2 text-left'
                            : 'rounded-lg border border-gray-200 px-3 py-2 text-left hover:bg-gray-50 dark:border-[#324467] dark:hover:bg-[#1a2539]'
                        }
                        key={item.user_id}
                        onClick={() => setSelectedPeerId(item.user_id)}
                        type="button"
                      >
                        <p className="text-sm font-semibold text-gray-900 dark:text-white">{getPeerDisplayName(item)}</p>
                        <p className="text-xs text-gray-500 dark:text-[#92a4c9]">ID: {item.user_id}</p>
                        {item.unread_count > 0 ? <p className="mt-1 text-xs font-medium text-red-500">Новых: {item.unread_count}</p> : null}
                      </button>
                    ))}
                  </div>
                )}
              </section>
            ) : null}

            <section
              className={
                scope === 'private'
                  ? 'flex min-h-[70vh] flex-col rounded-xl border border-gray-200 bg-white p-4 dark:border-[#324467] dark:bg-[#111722] xl:col-span-3'
                  : 'flex min-h-[70vh] flex-1 flex-col rounded-xl border border-gray-200 bg-white p-4 dark:border-[#324467] dark:bg-[#111722]'
              }
            >
              <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
                <p className="text-base font-semibold text-gray-900 dark:text-white">
                  {scope === 'global' ? 'Общий чат' : selectedPeer ? `Личный чат: ${getPeerDisplayName(selectedPeer)}` : 'Личный чат'}
                </p>
                <div className="flex gap-2">
                  <input
                    className="h-9 rounded-lg border border-gray-300 bg-white px-3 text-sm text-gray-900 outline-none focus:border-primary dark:border-[#324467] dark:bg-[#0f1728] dark:text-white"
                    onChange={(event) => setMessageSearch(event.target.value)}
                    placeholder="Поиск по сообщениям"
                    value={messageSearch}
                  />
                  <button
                    className="rounded-lg border border-gray-300 px-3 py-1 text-sm text-gray-700 hover:bg-gray-50 dark:border-[#324467] dark:text-white dark:hover:bg-[#1a2539]"
                    onClick={() => {
                      setNextBeforeId(null)
                      loadMessages({ appendOlder: false }).catch(() => {
                        setError('Не удалось обновить сообщения')
                      })
                    }}
                    type="button"
                  >
                    Обновить
                  </button>
                </div>
              </div>

              <div className="flex flex-1 flex-col gap-3 overflow-y-auto rounded-lg bg-gray-50 p-3 dark:bg-[#0f1728]">
                {hasMoreMessages ? (
                  <div className="flex justify-center">
                    <button
                      className="rounded-lg border border-gray-300 px-3 py-1 text-xs text-gray-700 hover:bg-gray-100 disabled:opacity-60 dark:border-[#324467] dark:text-white dark:hover:bg-[#1a2539]"
                      disabled={isLoadingOlder || nextBeforeId === null}
                      onClick={() => {
                        loadMessages({ appendOlder: true, beforeId: nextBeforeId }).catch(() => {
                          setError('Не удалось загрузить старые сообщения')
                        })
                      }}
                      type="button"
                    >
                      {isLoadingOlder ? 'Загрузка...' : 'Загрузить старые'}
                    </button>
                  </div>
                ) : null}

                {isLoadingMessages ? (
                  <p className="text-sm text-gray-500 dark:text-[#92a4c9]">Загрузка сообщений...</p>
                ) : messages.length === 0 ? (
                  <p className="text-sm text-gray-500 dark:text-[#92a4c9]">Сообщений пока нет.</p>
                ) : (
                  messages.map((message) => {
                    const isMine = message.sender_id === user.id
                    const isEditing = editingMessageId === message.id
                    const senderLabel = message.sender_username || `ID ${message.sender_id}`
                    const senderAvatarUrl = avatarByUserId.get(message.sender_id) ?? DEFAULT_AVATAR
                    const senderAvatarStyle = message.sender_id === user.id ? avatarImageStyle : undefined
                    return (
                      <div className={isMine ? 'flex justify-end' : 'flex justify-start'} key={message.id}>
                        {!isMine ? (
                          <div className="mr-2 mt-1 size-8 shrink-0 overflow-hidden rounded-full border border-gray-200 bg-white dark:border-[#324467] dark:bg-[#111722]">
                            <img
                              alt={senderLabel}
                              className="size-8 rounded-full object-cover object-center"
                              onError={handleAvatarError}
                              src={senderAvatarUrl}
                              style={senderAvatarStyle}
                            />
                          </div>
                        ) : null}
                        <div
                          className={
                            isMine
                              ? 'max-w-[90%] rounded-xl bg-primary px-3 py-2 text-white md:max-w-[75%]'
                              : 'max-w-[90%] rounded-xl border border-gray-200 bg-white px-3 py-2 text-gray-900 dark:border-[#324467] dark:bg-[#111722] dark:text-white md:max-w-[75%]'
                          }
                        >
                          <p className={isMine ? 'text-xs font-semibold text-white/90' : 'text-xs font-semibold text-gray-600 dark:text-[#92a4c9]'}>
                            {senderLabel}
                          </p>
                          {isEditing ? (
                            <div className="mt-1 flex flex-col gap-2">
                              <textarea
                                className="min-h-20 rounded-lg border border-white/30 bg-white/95 px-2 py-1 text-sm text-gray-900 outline-none"
                                maxLength={2000}
                                onChange={(event) => setEditingText(event.target.value)}
                                value={editingText}
                              />
                              <div className="flex gap-2">
                                <button
                                  className="rounded-md bg-white px-2 py-1 text-xs font-semibold text-primary"
                                  onClick={() => {
                                    handleSaveEdit(message.id).catch(() => {
                                      setError('Не удалось обновить сообщение')
                                    })
                                  }}
                                  type="button"
                                >
                                  Сохранить
                                </button>
                                <button
                                  className="rounded-md border border-white/50 px-2 py-1 text-xs text-white"
                                  onClick={() => {
                                    setEditingMessageId(null)
                                    setEditingText('')
                                  }}
                                  type="button"
                                >
                                  Отмена
                                </button>
                              </div>
                            </div>
                          ) : (
                            <p className="whitespace-pre-wrap break-words text-sm">{message.body}</p>
                          )}
                          <div className={isMine ? 'mt-1 flex items-center justify-between text-[11px] text-white/80' : 'mt-1 flex items-center justify-between text-[11px] text-gray-500 dark:text-[#92a4c9]'}>
                            <div className="inline-flex items-center gap-2">
                              <span>{formatMessageTime(message.created_at)}</span>
                              {message.edited_at ? <span>(изменено)</span> : null}
                            </div>
                            <div className="inline-flex items-center gap-2">
                              {getDeliveryLabel(message, isMine) ? <span>{getDeliveryLabel(message, isMine)}</span> : null}
                              {isMine && !message.is_deleted && !isEditing ? (
                                <>
                                  <button
                                    className="rounded border border-white/40 px-1.5 py-0.5 text-[10px]"
                                    onClick={() => {
                                      handleStartEdit(message).catch(() => {
                                        setError('Не удалось открыть режим редактирования')
                                      })
                                    }}
                                    type="button"
                                  >
                                    Изм.
                                  </button>
                                  <button
                                    className="rounded border border-white/40 px-1.5 py-0.5 text-[10px]"
                                    onClick={() => {
                                      handleDeleteMessage(message.id).catch(() => {
                                        setError('Не удалось удалить сообщение')
                                      })
                                    }}
                                    type="button"
                                  >
                                    Удалить
                                  </button>
                                </>
                              ) : null}
                            </div>
                          </div>
                        </div>
                        {isMine ? (
                          <div className="ml-2 mt-1 size-8 shrink-0 overflow-hidden rounded-full border border-white/30 bg-primary/10 dark:border-[#324467] dark:bg-[#111722]">
                            <img
                              alt={senderLabel}
                              className="size-8 rounded-full object-cover object-center"
                              onError={handleAvatarError}
                              src={senderAvatarUrl}
                              style={senderAvatarStyle}
                            />
                          </div>
                        ) : null}
                      </div>
                    )
                  })
                )}
                <div ref={messagesEndRef} />
              </div>

              <form className="mt-3 flex flex-col gap-2 sm:flex-row" onSubmit={handleSendMessage}>
                <input
                  className="h-10 flex-1 rounded-lg border border-gray-300 bg-white px-3 text-sm text-gray-900 outline-none focus:border-primary dark:border-[#324467] dark:bg-[#111722] dark:text-white"
                  maxLength={2000}
                  onChange={(event) => setMessageText(event.target.value)}
                  placeholder={scope === 'global' ? 'Напишите сообщение в общий чат...' : 'Напишите личное сообщение...'}
                  value={messageText}
                />
                <button
                  className="inline-flex h-10 items-center justify-center rounded-lg bg-primary px-4 text-sm font-semibold text-white hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-60"
                  disabled={isSending || (scope === 'private' && selectedPeerId === null)}
                  type="submit"
                >
                  Отправить
                </button>
              </form>
            </section>
          </div>
        </div>
      </main>
    </div>
  )
}
