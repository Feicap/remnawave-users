import { useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router'
import { useChatUnreadPing } from '../hooks/useChatUnreadPing'
import type { AuthUser } from '../types/auth'
import type { AdminUserItem, AdminUsersMetrics, AdminUsersResponse } from '../types/admin'
import type { ChatMessageItem, ChatScope } from '../types/chat'
import { buildAuthHeaders, clearStoredAuth, getStoredUser, refreshStoredAuthUser } from '../utils/auth'
import { isAdminUser } from '../utils/admin'

const USERS_REFRESH_MS = 30000
const CHAT_REFRESH_MS = 12000

const DEFAULT_METRICS: AdminUsersMetrics = {
  total_users: 0,
  online_users: 0,
  online_window_minutes: 15,
  remnawave_access_users: 0,
  users_without_password: 0,
  active_today: 0,
}

type UserFilter = 'all' | 'online' | 'remnawave' | 'need-password'

function getDisplayName(user: AuthUser): string {
  return user.display_name || user.username || user.telegram_username || user.email || 'Admin'
}

async function parseApiError(response: Response, fallback: string): Promise<string> {
  const payload = (await response.json().catch(() => null)) as { error?: string } | null
  return payload?.error || fallback
}

function formatDateTime(value: string | null): string {
  if (!value) {
    return 'never'
  }
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) {
    return 'invalid date'
  }
  return date.toLocaleString('ru-RU')
}

export default function Admin() {
  const navigate = useNavigate()
  const [user, setUser] = useState<AuthUser | null>(() => getStoredUser())
  const { totalUnread } = useChatUnreadPing(user)

  const [users, setUsers] = useState<AdminUserItem[]>([])
  const [metrics, setMetrics] = useState<AdminUsersMetrics>(DEFAULT_METRICS)
  const [chatMessages, setChatMessages] = useState<ChatMessageItem[]>([])

  const [isLoadingUsers, setIsLoadingUsers] = useState(true)
  const [isLoadingChat, setIsLoadingChat] = useState(true)
  const [isSaving, setIsSaving] = useState(false)

  const [search, setSearch] = useState('')
  const [filter, setFilter] = useState<UserFilter>('all')
  const [selectedUserId, setSelectedUserId] = useState<number | null>(null)

  const [editLogin, setEditLogin] = useState('')
  const [editPassword, setEditPassword] = useState('')
  const [editDisplayName, setEditDisplayName] = useState('')
  const [editChatUsername, setEditChatUsername] = useState('')
  const [editChatEmail, setEditChatEmail] = useState('')
  const [editTelegramUsername, setEditTelegramUsername] = useState('')
  const [editPhoto, setEditPhoto] = useState('')
  const [editAuthProvider, setEditAuthProvider] = useState('')
  const [editAvatarFile, setEditAvatarFile] = useState<File | null>(null)
  const [removeAvatar, setRemoveAvatar] = useState(false)

  const [chatScope, setChatScope] = useState<'all' | ChatScope>('all')
  const [chatUserIdFilter, setChatUserIdFilter] = useState('')
  const [chatPeerIdFilter, setChatPeerIdFilter] = useState('')

  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')

  const selectedUser = useMemo(() => users.find((u) => u.id === selectedUserId) ?? null, [users, selectedUserId])

  const filteredUsers = useMemo(() => {
    const q = search.trim().toLowerCase()
    return users.filter((u) => {
      if (filter === 'online' && !u.is_online) return false
      if (filter === 'remnawave' && !u.has_remnawave_access) return false
      if (filter === 'need-password' && u.has_password) return false
      if (!q) return true
      return `${u.id} ${u.login} ${u.email} ${u.display_name} ${u.chat_telegram_username}`.toLowerCase().includes(q)
    })
  }, [filter, search, users])

  const loadUsers = useCallback(async (showLoader: boolean) => {
    if (!user) return
    if (showLoader) setIsLoadingUsers(true)

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
      setError('Сетевая ошибка при загрузке пользователей')
    } finally {
      setIsLoadingUsers(false)
    }
  }, [navigate, user])

  const loadChatAudit = useCallback(async (showLoader: boolean) => {
    if (!user) return
    if (showLoader) setIsLoadingChat(true)

    const query = new URLSearchParams({
      limit: '200',
      scope: chatScope,
    })
    if (chatUserIdFilter.trim()) query.set('user_id', chatUserIdFilter.trim())
    if (chatPeerIdFilter.trim()) query.set('peer_id', chatPeerIdFilter.trim())

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
        setError(await parseApiError(response, 'Не удалось загрузить сообщения чата'))
        return
      }
      const payload = (await response.json()) as { items: ChatMessageItem[] }
      setChatMessages(payload.items)
    } catch {
      setError('Сетевая ошибка при загрузке сообщений чата')
    } finally {
      setIsLoadingChat(false)
    }
  }, [chatPeerIdFilter, chatScope, chatUserIdFilter, navigate, user])

  useEffect(() => {
    const stored = getStoredUser()
    if (!stored) {
      navigate('/auth')
      return
    }
    if (!isAdminUser(stored)) {
      navigate('/profile')
      return
    }
    refreshStoredAuthUser(stored).then(setUser).catch(() => {
      setError('Не удалось обновить профиль администратора')
    })
  }, [navigate])

  useEffect(() => {
    if (!user || !isAdminUser(user)) return
    loadUsers(true).catch(() => {
      setError('Не удалось загрузить пользователей')
    })
    const timer = window.setInterval(() => {
      loadUsers(false).catch(() => null)
    }, USERS_REFRESH_MS)
    return () => window.clearInterval(timer)
  }, [loadUsers, user])

  useEffect(() => {
    if (!user || !isAdminUser(user)) return
    loadChatAudit(true).catch(() => {
      setError('Не удалось загрузить чат')
    })
    const timer = window.setInterval(() => {
      loadChatAudit(false).catch(() => null)
    }, CHAT_REFRESH_MS)
    return () => window.clearInterval(timer)
  }, [loadChatAudit, user])

  useEffect(() => {
    if (users.length === 0) {
      setSelectedUserId(null)
      return
    }
    setSelectedUserId((prev) => (prev !== null && users.some((item) => item.id === prev) ? prev : users[0].id))
  }, [users])

  useEffect(() => {
    if (!selectedUser) {
      setEditLogin('')
      setEditPassword('')
      return
    }
    setEditLogin(selectedUser.login)
    setEditPassword('')
    setEditDisplayName(selectedUser.display_name || '')
    setEditChatUsername(selectedUser.chat_username || '')
    setEditChatEmail(selectedUser.chat_email || '')
    setEditTelegramUsername(selectedUser.chat_telegram_username || '')
    setEditPhoto(selectedUser.chat_photo || '')
    setEditAuthProvider(selectedUser.chat_auth_provider || '')
    setEditAvatarFile(null)
    setRemoveAvatar(false)
    setNotice('')
  }, [selectedUser])

  if (!user || !isAdminUser(user)) {
    return <div>Loading...</div>
  }

  async function handleSaveUser() {
    if (!selectedUser || !user) return
    const data = new FormData()
    let changed = false

    const nextLogin = editLogin.trim().toLowerCase()
    if (!nextLogin) {
      setError('Логин не может быть пустым')
      return
    }
    if (nextLogin !== selectedUser.login.toLowerCase()) {
      data.append('login', nextLogin)
      changed = true
    }
    if (editPassword.trim()) {
      data.append('password', editPassword)
      changed = true
    }

    if (editDisplayName.trim() !== (selectedUser.display_name || '')) { data.append('display_name', editDisplayName.trim()); changed = true }
    if (editChatUsername.trim() !== (selectedUser.chat_username || '')) { data.append('chat_username', editChatUsername.trim()); changed = true }
    if (editChatEmail.trim().toLowerCase() !== (selectedUser.chat_email || '').toLowerCase()) { data.append('chat_email', editChatEmail.trim().toLowerCase()); changed = true }
    if (editTelegramUsername.trim() !== (selectedUser.chat_telegram_username || '')) { data.append('telegram_username', editTelegramUsername.trim()); changed = true }
    if (editPhoto.trim() !== (selectedUser.chat_photo || '')) { data.append('photo', editPhoto.trim()); changed = true }
    if (editAuthProvider.trim().toLowerCase() !== (selectedUser.chat_auth_provider || '')) { data.append('auth_provider', editAuthProvider.trim().toLowerCase()); changed = true }
    if (editAvatarFile) { data.append('avatar', editAvatarFile); changed = true }
    if (removeAvatar) { data.append('remove_avatar', 'true'); changed = true }

    if (!changed) {
      setNotice('Нет изменений для сохранения')
      return
    }

    setIsSaving(true)
    setError('')
    setNotice('')
    try {
      const response = await fetch(`/api/admin/users/${selectedUser.id}/`, {
        method: 'PATCH',
        headers: buildAuthHeaders(user),
        body: data,
      })
      if (!response.ok) {
        setError(await parseApiError(response, 'Не удалось сохранить пользователя'))
        return
      }
      setNotice('Пользователь обновлен')
      setEditPassword('')
      setEditAvatarFile(null)
      setRemoveAvatar(false)
      await loadUsers(false)
    } catch {
      setError('Сетевая ошибка при сохранении пользователя')
    } finally {
      setIsSaving(false)
    }
  }

  async function handleResetPassword() {
    if (!selectedUser || !user) return
    setIsSaving(true)
    setError('')
    setNotice('')
    try {
      const response = await fetch(`/api/admin/users/${selectedUser.id}/reset-password/`, {
        method: 'POST',
        headers: buildAuthHeaders(user),
      })
      if (!response.ok) {
        setError(await parseApiError(response, 'Не удалось сбросить пароль'))
        return
      }
      setNotice('Пароль сброшен')
      await loadUsers(false)
    } catch {
      setError('Сетевая ошибка при сбросе пароля')
    } finally {
      setIsSaving(false)
    }
  }

  return (
    <div className="flex min-h-screen flex-col gap-4 bg-gray-50 p-4 dark:bg-[#0d1321]">
      <header className="flex items-center justify-between rounded-xl border border-gray-200 bg-white p-4 dark:border-[#324467] dark:bg-[#111722]">
        <div>
          <p className="text-xl font-bold text-gray-900 dark:text-white">Admin</p>
          <p className="text-sm text-gray-500 dark:text-[#92a4c9]">{getDisplayName(user)}</p>
        </div>
        <div className="flex items-center gap-2">
          <button className="rounded-lg border px-3 py-2 text-sm" onClick={() => navigate('/profile')} type="button">Профиль</button>
          <button className="rounded-lg border px-3 py-2 text-sm" onClick={() => navigate('/admin-check')} type="button">Проверка оплат</button>
          <button className="rounded-lg border px-3 py-2 text-sm" onClick={() => navigate('/chat')} type="button">Чат ({totalUnread})</button>
          <button className="rounded-lg bg-primary px-3 py-2 text-sm text-white" onClick={() => { clearStoredAuth(); navigate('/auth') }} type="button">Выйти</button>
        </div>
      </header>

      <section className="grid grid-cols-2 gap-2 md:grid-cols-6">
        <div className="rounded-lg border bg-white p-2 text-sm dark:border-[#324467] dark:bg-[#111722]">Всего: {metrics.total_users}</div>
        <div className="rounded-lg border bg-white p-2 text-sm dark:border-[#324467] dark:bg-[#111722]">Онлайн: {metrics.online_users}</div>
        <div className="rounded-lg border bg-white p-2 text-sm dark:border-[#324467] dark:bg-[#111722]">Remnawave: {metrics.remnawave_access_users}</div>
        <div className="rounded-lg border bg-white p-2 text-sm dark:border-[#324467] dark:bg-[#111722]">Без пароля: {metrics.users_without_password}</div>
        <div className="rounded-lg border bg-white p-2 text-sm dark:border-[#324467] dark:bg-[#111722]">Сегодня: {metrics.active_today}</div>
        <div className="rounded-lg border bg-white p-2 text-sm dark:border-[#324467] dark:bg-[#111722]">Окно: {metrics.online_window_minutes}m</div>
      </section>

      {error ? <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div> : null}
      {notice ? <div className="rounded-lg border border-green-200 bg-green-50 px-3 py-2 text-sm text-green-700">{notice}</div> : null}

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-3">
        <section className="xl:col-span-2 rounded-xl border border-gray-200 bg-white p-4 dark:border-[#324467] dark:bg-[#111722]">
          <div className="mb-3 flex gap-2">
            <input className="h-9 flex-1 rounded border px-2" placeholder="search" value={search} onChange={(e) => setSearch(e.target.value)} />
            <select className="h-9 rounded border px-2" value={filter} onChange={(e) => setFilter(e.target.value as UserFilter)}>
              <option value="all">all</option><option value="online">online</option><option value="remnawave">remnawave</option><option value="need-password">need-password</option>
            </select>
          </div>
          {isLoadingUsers ? <p>loading...</p> : (
            <div className="max-h-[52vh] overflow-auto">
              <table className="min-w-full text-sm"><thead><tr><th className="text-left">user</th><th className="text-left">online</th><th className="text-left">pass</th><th className="text-left">last</th></tr></thead>
              <tbody>
                {filteredUsers.map((u) => (
                  <tr key={u.id} className={u.id === selectedUserId ? 'bg-primary/10 cursor-pointer' : 'cursor-pointer'} onClick={() => setSelectedUserId(u.id)}>
                    <td>{u.login}<div className="text-xs opacity-70">{u.display_name || '-'} · {u.email || '-'}</div></td>
                    <td>{u.is_online ? 'yes' : 'no'}</td>
                    <td>{u.has_password ? 'set' : 'reset'}</td>
                    <td>{formatDateTime(u.last_login)}</td>
                  </tr>
                ))}
              </tbody></table>
            </div>
          )}
        </section>

        <section className="rounded-xl border border-gray-200 bg-white p-4 dark:border-[#324467] dark:bg-[#111722]">
          {!selectedUser ? <p>Выберите пользователя</p> : (
            <div className="space-y-2 text-sm">
              <p className="font-semibold">ID {selectedUser.id}</p>
              <input className="h-9 w-full rounded border px-2" value={editLogin} onChange={(e) => setEditLogin(e.target.value)} placeholder="login" />
              <input className="h-9 w-full rounded border px-2" value={editDisplayName} onChange={(e) => setEditDisplayName(e.target.value)} placeholder="display_name" maxLength={64} />
              <input className="h-9 w-full rounded border px-2" value={editChatUsername} onChange={(e) => setEditChatUsername(e.target.value)} placeholder="chat_username" />
              <input className="h-9 w-full rounded border px-2" value={editChatEmail} onChange={(e) => setEditChatEmail(e.target.value)} placeholder="chat_email" />
              <input className="h-9 w-full rounded border px-2" value={editTelegramUsername} onChange={(e) => setEditTelegramUsername(e.target.value)} placeholder="telegram_username" />
              <input className="h-9 w-full rounded border px-2" value={editPhoto} onChange={(e) => setEditPhoto(e.target.value)} placeholder="photo url" />
              <select className="h-9 w-full rounded border px-2" value={editAuthProvider} onChange={(e) => setEditAuthProvider(e.target.value)}>
                <option value="">auto</option><option value="email">email</option><option value="telegram">telegram</option>
              </select>
              <input className="h-9 w-full rounded border px-2" value={editPassword} onChange={(e) => setEditPassword(e.target.value)} placeholder="new password" type="password" />
              <input accept=".jpg,.jpeg,.png,.webp,.bmp,.heic,.svg" onChange={(e) => { setEditAvatarFile(e.target.files?.[0] ?? null); if (e.target.files?.[0]) setRemoveAvatar(false) }} type="file" />
              <label className="inline-flex items-center gap-2"><input checked={removeAvatar} onChange={(e) => { setRemoveAvatar(e.target.checked); if (e.target.checked) setEditAvatarFile(null) }} type="checkbox" />remove avatar</label>
              <button className="h-9 w-full rounded bg-primary text-white disabled:opacity-60" disabled={isSaving} onClick={handleSaveUser} type="button">Сохранить</button>
              <button className="h-9 w-full rounded border border-red-300 text-red-600 disabled:opacity-60" disabled={isSaving} onClick={handleResetPassword} type="button">Сбросить пароль</button>
            </div>
          )}
        </section>
      </div>

      <section className="rounded-xl border border-gray-200 bg-white p-4 dark:border-[#324467] dark:bg-[#111722]">
        <div className="mb-2 flex gap-2">
          <select className="h-9 rounded border px-2" value={chatScope} onChange={(e) => setChatScope(e.target.value as 'all' | ChatScope)}>
            <option value="all">all</option><option value="global">global</option><option value="private">private</option>
          </select>
          <input className="h-9 rounded border px-2" placeholder="user_id" value={chatUserIdFilter} onChange={(e) => setChatUserIdFilter(e.target.value)} />
          <input className="h-9 rounded border px-2" placeholder="peer_id" value={chatPeerIdFilter} onChange={(e) => setChatPeerIdFilter(e.target.value)} />
          <button className="h-9 rounded bg-primary px-3 text-white" onClick={() => loadChatAudit(true).catch(() => null)} type="button">refresh</button>
        </div>
        {isLoadingChat ? <p>loading chat...</p> : (
          <div className="max-h-[36vh] overflow-auto">
            <table className="min-w-full text-sm"><thead><tr><th className="text-left">time</th><th className="text-left">scope</th><th className="text-left">from</th><th className="text-left">to</th><th className="text-left">text</th></tr></thead>
            <tbody>
              {chatMessages.map((m) => (
                <tr key={m.id}>
                  <td>{formatDateTime(m.created_at)}</td>
                  <td>{m.scope}</td>
                  <td>{m.sender_username} ({m.sender_id})</td>
                  <td>{m.scope === 'global' ? 'all' : `${m.recipient_username || 'user'} (${m.recipient_id ?? '-'})`}</td>
                  <td>{m.body}</td>
                </tr>
              ))}
            </tbody></table>
          </div>
        )}
      </section>
    </div>
  )
}
