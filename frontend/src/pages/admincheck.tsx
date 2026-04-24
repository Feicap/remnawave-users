import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router'
import { useChatUnreadPing } from '../hooks/useChatUnreadPing'
import type { AuthUser } from '../types/auth'
import type { PaymentProof, PaymentProofUser, PaymentStatus } from '../types/payment'
import { buildAuthHeaders, clearStoredAuth, getStoredUser, refreshStoredAuthUser, withStoredAvatarVersion } from '../utils/auth'
import { isAdminUser } from '../utils/admin'
import { getAvatarImageStyle } from '../utils/avatar'

const DEFAULT_AVATAR =
  'https://lh3.googleusercontent.com/aida-public/AB6AXuD7QfEnuqRCntNYH9h2Vpo3jzR2BMfMqxHuHq-ivlguZcwzF_lfmadLZHf4vT8CfrKoIUNDPR1MmHqWK_suVK1pQOJXx0sSYBdAc3HCdZbWyuwNnuAj95xWWZilTRSMiKUfTt-6lFPSIvaV577Wik1oYO_ONDLJYuA5yaDJJSU7PwQfDQftZAILVh17O3KQr1s3dq56Z1g5mUvalbeTkomtJfUowYTnX-9km8Hdzb5Wm8IyfcVbawTAHqT3EkFdUrXJHLDkkTopp-E'

function statusBadge(status: PaymentStatus): { label: string; className: string } {
  if (status === 'approved') {
    return { label: 'Подтверждено', className: 'text-green-500 bg-green-500/10' }
  }
  if (status === 'rejected') {
    return { label: 'Отклонено', className: 'text-red-500 bg-red-500/10' }
  }
  return { label: 'Ожидает', className: 'text-gray-500 bg-gray-500/10' }
}

function getTelegramId(user: AuthUser): number | null {
  if (typeof user.telegram_id === 'number' && Number.isFinite(user.telegram_id)) {
    return user.telegram_id
  }
  return null
}

function getDisplayName(user: AuthUser): string {
  return user.display_name || user.username || user.telegram_username || user.email || 'Admin'
}

export default function AdminCheck() {
  const navigate = useNavigate()
  const [user, setUser] = useState<AuthUser | null>(() => getStoredUser())
  const { totalUnread } = useChatUnreadPing(user)
  const [users, setUsers] = useState<PaymentProofUser[]>([])
  const [selectedUserId, setSelectedUserId] = useState<number | null>(null)
  const [proofs, setProofs] = useState<PaymentProof[]>([])
  const [error, setError] = useState('')
  const [isUpdating, setIsUpdating] = useState(false)
  const [imageUrls, setImageUrls] = useState<Record<number, string>>({})
  const [previewUrl, setPreviewUrl] = useState<string | null>(null)
  const imageBlobUrlsRef = useRef<string[]>([])
  const userRef = useRef<AuthUser | null>(user)

  const isAdmin = useMemo(() => (user ? isAdminUser(user) : false), [user])

  useEffect(() => {
    userRef.current = user
  }, [user])

  const loadUsers = useCallback(async () => {
    if (!user) {
      return
    }
    const res = await fetch('/api/admin/payment-proofs/users/', { headers: buildAuthHeaders(user) })
    if (!res.ok) {
      throw new Error('Не удалось загрузить список пользователей')
    }
    const payload = (await res.json()) as { items: PaymentProofUser[] }
    setUsers(payload.items)
    if (!selectedUserId && payload.items.length > 0) {
      setSelectedUserId(payload.items[0].user_id)
    }
  }, [user, selectedUserId])

  const loadProofs = useCallback(async () => {
    if (!user || !selectedUserId) {
      return
    }
    const res = await fetch(`/api/admin/payment-proofs/?user_id=${selectedUserId}`, { headers: buildAuthHeaders(user) })
    if (!res.ok) {
      throw new Error('Не удалось загрузить заявки пользователя')
    }
    const payload = (await res.json()) as { items: PaymentProof[] }
    setProofs(payload.items)
  }, [user, selectedUserId])

  useEffect(() => {
    const currentUser = userRef.current
    if (!currentUser) {
      navigate('/auth')
      return
    }
    if (!isAdminUser(currentUser)) {
      navigate('/profile')
      return
    }

    refreshStoredAuthUser(currentUser)
      .then((nextUser) => setUser(nextUser))
      .catch(() => {
        // Оставляем данные из localStorage, если сейчас не удалось обновить профиль.
      })

    Promise.all([loadUsers(), loadProofs()]).catch((e: unknown) => {
      setError(e instanceof Error ? e.message : 'Ошибка загрузки')
    })

    const interval = setInterval(() => {
      Promise.all([loadUsers(), loadProofs()]).catch(() => {
        // Молча игнорируем временные ошибки автообновления.
      })
    }, 5000)
    return () => clearInterval(interval)
  }, [navigate, user?.id, loadUsers, loadProofs])

  useEffect(() => {
    loadProofs().catch((e: unknown) => {
      setError(e instanceof Error ? e.message : 'Ошибка загрузки')
    })
  }, [loadProofs])

  useEffect(() => {
    if (!user || proofs.length === 0) {
      setImageUrls({})
      return
    }
    const currentUser = user
    let cancelled = false
    const controllers: AbortController[] = []

    async function loadImages() {
      const next: Record<number, string> = {}
      for (const proof of proofs) {
        const controller = new AbortController()
        controllers.push(controller)
        const res = await fetch(proof.file_url, {
          headers: buildAuthHeaders(currentUser),
          signal: controller.signal,
        })
        if (!res.ok) {
          continue
        }
        const blob = await res.blob()
        const url = URL.createObjectURL(blob)
        imageBlobUrlsRef.current.push(url)
        next[proof.id] = url
      }

      if (!cancelled) {
        setImageUrls(next)
      }
    }

    loadImages().catch(() => {
      // Молча игнорируем ошибки загрузки превью.
    })

    return () => {
      cancelled = true
      for (const c of controllers) {
        c.abort()
      }
      for (const url of imageBlobUrlsRef.current) {
        URL.revokeObjectURL(url)
      }
      imageBlobUrlsRef.current = []
    }
  }, [proofs, user])

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        setPreviewUrl(null)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  if (!user || !isAdmin) {
    return <div>Loading...</div>
  }

  const telegramId = getTelegramId(user)
  const avatarUrl = withStoredAvatarVersion(user.photo) || DEFAULT_AVATAR
  const avatarImageStyle = getAvatarImageStyle(user)

  async function updateStatus(proofId: number, status: PaymentStatus) {
    if (!user) {
      return
    }
    setIsUpdating(true)
    setError('')
    try {
      const res = await fetch(`/api/admin/payment-proofs/${proofId}/`, {
        method: 'PATCH',
        headers: {
          ...buildAuthHeaders(user),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ status }),
      })
      if (!res.ok) {
        const payload = (await res.json().catch(() => ({ error: 'Ошибка модерации' }))) as { error?: string }
        throw new Error(payload.error || 'Ошибка модерации')
      }
      await Promise.all([loadUsers(), loadProofs()])
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Ошибка модерации')
    } finally {
      setIsUpdating(false)
    }
  }

  async function deleteProof(proofId: number) {
    if (!user) {
      return
    }

    const confirmed = window.confirm('Удалить это фото без возможности восстановления?')
    if (!confirmed) {
      return
    }

    setIsUpdating(true)
    setError('')
    try {
      const res = await fetch(`/api/admin/payment-proofs/${proofId}/`, {
        method: 'DELETE',
        headers: buildAuthHeaders(user),
      })
      if (!res.ok) {
        const payload = (await res.json().catch(() => ({ error: 'Ошибка удаления' }))) as { error?: string }
        throw new Error(payload.error || 'Ошибка удаления')
      }
      await Promise.all([loadUsers(), loadProofs()])
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Ошибка удаления')
    } finally {
      setIsUpdating(false)
    }
  }

  function handleBackToAdmin() {
    navigate('/admin')
  }

  function handleBackToProfile() {
    navigate('/profile')
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
      <aside className="w-full md:w-64 md:flex-shrink-0 bg-white dark:bg-[#111722] p-4 flex flex-col justify-between border-b md:border-b-0 md:border-r border-gray-200 dark:border-gray-800">
        <div className="flex flex-col gap-8">
          <div className="flex items-center gap-3 px-2">
            <span className="material-symbols-outlined text-primary text-3xl">shield</span>
            <span className="text-xl font-bold text-gray-900 dark:text-white">Мой VPS</span>
          </div>
          <div className="flex flex-col gap-4">
            <div className="flex items-center gap-3 px-3 py-2">
              <div className="size-10 shrink-0 overflow-hidden rounded-full bg-gray-100 dark:bg-[#1a2539]">
                <img alt={getDisplayName(user)} className="size-10 rounded-full object-cover object-center" src={avatarUrl} style={avatarImageStyle} />
              </div>
              <div className="flex flex-col">
                <h1 className="text-gray-900 dark:text-white text-base font-medium leading-normal">
                  {getDisplayName(user)}
                </h1>
                {user.email ? (
                  <p className="text-gray-500 dark:text-[#92a4c9] text-sm font-normal leading-normal">{user.email}</p>
                ) : null}
                {telegramId !== null ? (
                  <p className="text-gray-500 dark:text-[#92a4c9] text-sm font-normal leading-normal">
                    Telegram ID: {telegramId}
                  </p>
                ) : null}
              </div>
            </div>
          </div>
          <div className="flex flex-col gap-2">
            <button
              onClick={handleBackToAdmin}
              className="flex items-center gap-3 px-3 py-2 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-800/50 cursor-pointer text-left"
              type="button"
            >
              <span className="material-symbols-outlined text-gray-500 dark:text-white">admin_panel_settings</span>
              <p className="text-gray-700 dark:text-white text-sm font-medium leading-normal">Админ панель</p>
            </button>
            <button
              className="flex items-center gap-3 px-3 py-2 rounded-lg bg-primary/10 dark:bg-[#232f48] text-left"
              type="button"
            >
              <span className="material-symbols-outlined text-primary dark:text-white">credit_card</span>
              <p className="text-primary dark:text-white text-sm font-medium leading-normal">Проверка оплаты</p>
            </button>
            <button
              onClick={handleChat}
              className="flex items-center gap-3 px-3 py-2 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-800/50 cursor-pointer text-left"
              type="button"
            >
              <div className="relative inline-flex items-center">
                <span className="material-symbols-outlined text-gray-500 dark:text-white">chat</span>
                {totalUnread > 0 ? (
                  <span className="absolute -right-2 -top-1 inline-flex min-w-4 items-center justify-center rounded-full bg-red-500 px-1 text-[10px] font-semibold text-white">
                    {totalUnread > 99 ? '99+' : totalUnread}
                  </span>
                ) : null}
              </div>
              <p className="text-gray-700 dark:text-white text-sm font-medium leading-normal">Чат</p>
            </button>
            <button
              onClick={handleBackToProfile}
              className="flex items-center gap-3 px-3 py-2 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-800/50 cursor-pointer text-left"
              type="button"
            >
              <span className="material-symbols-outlined text-gray-500 dark:text-white">arrow_back</span>
              <p className="text-gray-700 dark:text-white text-sm font-medium leading-normal">Обратно в профиль</p>
            </button>
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
        <div className="max-w-7xl mx-auto flex flex-col xl:flex-row gap-4 md:gap-6 min-h-full">
          <section className="w-full xl:w-80 bg-white dark:bg-[#111722] rounded-xl border border-gray-200 dark:border-[#324467] p-4 overflow-y-auto">
            <h2 className="text-gray-900 dark:text-white text-lg font-bold mb-4">Пользователи</h2>
            <div className="flex flex-col gap-2">
              {users.map((item) => (
                <button
                  key={item.user_id}
                  onClick={() => setSelectedUserId(item.user_id)}
                  className={`w-full rounded-lg px-3 py-2 text-left border ${
                    selectedUserId === item.user_id
                      ? 'border-primary bg-primary/10'
                      : 'border-gray-200 dark:border-[#324467] hover:bg-gray-50 dark:hover:bg-[#1a2539]'
                  }`}
                  type="button"
                >
                  <p className="text-sm font-semibold text-gray-900 dark:text-white">{item.username || `id:${item.user_id}`}</p>
                  <p className="text-xs text-gray-500 dark:text-[#92a4c9]">ID: {item.user_id}</p>
                  {item.pending_count > 0 ? (
                    <p className="text-xs text-yellow-500 mt-1">Ожидают: {item.pending_count}</p>
                  ) : null}
                </button>
              ))}
            </div>
          </section>

          <section className="flex-1 bg-white dark:bg-[#111722] rounded-xl border border-gray-200 dark:border-[#324467] p-6 overflow-y-auto">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-gray-900 dark:text-white text-lg font-bold">Заявки пользователя</h2>
              {error ? <p className="text-sm text-red-500">{error}</p> : null}
            </div>

            <div className="flex flex-col gap-4">
              {proofs.length === 0 ? (
                <p className="text-sm text-gray-500 dark:text-[#92a4c9]">Нет заявок для выбранного пользователя.</p>
              ) : (
                proofs.map((proof) => {
                  const badge = statusBadge(proof.status)
                  return (
                    <div key={proof.id} className="rounded-xl border border-gray-200 dark:border-[#324467] p-4 bg-gray-50 dark:bg-[#1a2539]">
                      {!imageUrls[proof.id] ? (
                        <div className="w-full h-56 rounded-lg mb-3 bg-gray-200/40 dark:bg-[#0f172a] animate-pulse" />
                      ) : (
                        <button className="w-full" onClick={() => setPreviewUrl(imageUrls[proof.id])} type="button">
                          <img
                            alt={`proof-${proof.id}`}
                            className="w-full max-h-96 object-contain rounded-lg mb-3"
                            src={imageUrls[proof.id]}
                          />
                        </button>
                      )}
                      <div className="flex flex-wrap items-center justify-between gap-3">
                        <div>
                          <p className="text-sm text-gray-900 dark:text-white">
                            Отправлено: {new Date(proof.created_at).toLocaleString('ru-RU')}
                          </p>
                          <span className={`inline-flex rounded-full px-2 py-1 text-xs font-medium mt-2 ${badge.className}`}>
                            {badge.label}
                          </span>
                        </div>
                        <div className="flex flex-wrap items-center gap-2">
                          <button
                            onClick={() => updateStatus(proof.id, 'approved')}
                            className="flex h-9 w-9 items-center justify-center rounded-md bg-green-500/20 text-sm font-medium text-green-500 hover:bg-green-500/30 disabled:opacity-60 sm:w-auto sm:gap-1 sm:px-3"
                            disabled={isUpdating || proof.status === 'approved'}
                            type="button"
                          >
                            <span className="material-symbols-outlined text-base">check_circle</span>
                            <span className="hidden sm:inline">Подтвердить</span>
                          </button>
                          <button
                            onClick={() => updateStatus(proof.id, 'rejected')}
                            className="flex h-9 w-9 items-center justify-center rounded-md bg-red-500/20 text-sm font-medium text-red-500 hover:bg-red-500/30 disabled:opacity-60 sm:w-auto sm:gap-1 sm:px-3"
                            disabled={isUpdating || proof.status === 'rejected'}
                            type="button"
                          >
                            <span className="material-symbols-outlined text-base">cancel</span>
                            <span className="hidden sm:inline">Отклонить</span>
                          </button>
                          <button
                            onClick={() => updateStatus(proof.id, 'pending')}
                            className="flex h-9 w-9 items-center justify-center rounded-md bg-gray-500/20 text-sm font-medium text-gray-500 hover:bg-gray-500/30 disabled:opacity-60 sm:w-auto sm:gap-1 sm:px-3"
                            disabled={isUpdating || proof.status === 'pending'}
                            type="button"
                          >
                            <span className="material-symbols-outlined text-base">schedule</span>
                            <span className="hidden sm:inline">Ожидание</span>
                          </button>
                          <button
                            onClick={() => deleteProof(proof.id)}
                            className="flex h-9 w-9 items-center justify-center rounded-md bg-red-600/20 text-sm font-medium text-red-600 hover:bg-red-600/30 disabled:opacity-60 sm:w-auto sm:gap-1 sm:px-3"
                            disabled={isUpdating}
                            type="button"
                          >
                            <span className="material-symbols-outlined text-base">delete</span>
                            <span className="hidden sm:inline">Удалить</span>
                          </button>
                        </div>
                      </div>
                    </div>
                  )
                })
              )}
            </div>
          </section>
        </div>
      </main>
      {previewUrl ? (
        <div
          className="fixed inset-0 z-50 bg-black/85 flex items-center justify-center p-4"
          onClick={() => setPreviewUrl(null)}
        >
          <button
            className="absolute top-4 right-4 text-white bg-black/40 rounded-full h-10 w-10 flex items-center justify-center"
            onClick={() => setPreviewUrl(null)}
            type="button"
          >
            <span className="material-symbols-outlined">close</span>
          </button>
          <img
            alt="preview"
            className="max-h-[92vh] max-w-[96vw] object-contain rounded-lg"
            onClick={(event) => event.stopPropagation()}
            src={previewUrl}
          />
        </div>
      ) : null}
    </div>
  )
}

