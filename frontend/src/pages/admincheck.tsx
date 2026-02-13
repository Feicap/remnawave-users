import { useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router'
import type { TelegramUser } from '../types/telegram'
import type { PaymentProof, PaymentProofUser, PaymentStatus } from '../types/payment'
import { buildAuthHeaders, getStoredUser } from '../utils/auth'
import { isAdminUserId } from '../utils/admin'

interface AuthenticatedUser extends TelegramUser {
  token: string
}

function statusBadge(status: PaymentStatus): { label: string; className: string } {
  if (status === 'approved') {
    return { label: 'Подтверждено', className: 'text-green-500 bg-green-500/10' }
  }
  if (status === 'rejected') {
    return { label: 'Отклонено', className: 'text-red-500 bg-red-500/10' }
  }
  return { label: 'Ожидает', className: 'text-gray-500 bg-gray-500/10' }
}

export default function AdminCheck() {
  const navigate = useNavigate()
  const [user] = useState<AuthenticatedUser | null>(() => getStoredUser() as AuthenticatedUser | null)
  const [users, setUsers] = useState<PaymentProofUser[]>([])
  const [selectedUserId, setSelectedUserId] = useState<number | null>(null)
  const [proofs, setProofs] = useState<PaymentProof[]>([])
  const [error, setError] = useState('')
  const [isUpdating, setIsUpdating] = useState(false)

  const isAdmin = useMemo(() => (user ? isAdminUserId(user.id) : false), [user])

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
    if (!user) {
      navigate('/auth')
      return
    }
    if (!isAdminUserId(user.id)) {
      navigate('/profile')
      return
    }

    Promise.all([loadUsers(), loadProofs()]).catch((e: unknown) => {
      setError(e instanceof Error ? e.message : 'Ошибка загрузки')
    })

    const interval = setInterval(() => {
      Promise.all([loadUsers(), loadProofs()]).catch(() => {
        // Ignore polling errors silently.
      })
    }, 5000)
    return () => clearInterval(interval)
  }, [navigate, user, loadUsers, loadProofs])

  useEffect(() => {
    loadProofs().catch((e: unknown) => {
      setError(e instanceof Error ? e.message : 'Ошибка загрузки')
    })
  }, [loadProofs])

  if (!user || !isAdmin) {
    return <div>Loading...</div>
  }

  async function updateStatus(proofId: number, status: Exclude<PaymentStatus, 'pending'>) {
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

  function handleBackToAdmin() {
    navigate('/admin')
  }

  function handleBackToProfile() {
    navigate('/profile')
  }

  function handleLogout() {
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
          <div className="flex flex-col gap-2">
            <button
              onClick={handleBackToAdmin}
              className="flex items-center gap-3 px-3 py-2 rounded-lg bg-primary/10 dark:bg-[#232f48] text-left"
              type="button"
            >
              <span className="material-symbols-outlined text-primary dark:text-white">credit_card</span>
              <p className="text-primary dark:text-white text-sm font-medium leading-normal">Проверка оплаты</p>
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

      <main className="flex-1 p-6 lg:p-10 overflow-y-auto">
        <div className="max-w-7xl mx-auto flex gap-6 h-full">
          <section className="w-80 bg-white dark:bg-[#111722] rounded-xl border border-gray-200 dark:border-[#324467] p-4 overflow-y-auto">
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
                      <img alt={`proof-${proof.id}`} className="w-full max-h-96 object-contain rounded-lg mb-3" src={proof.file_url} />
                      <div className="flex flex-wrap items-center justify-between gap-3">
                        <div>
                          <p className="text-sm text-gray-900 dark:text-white">Отправлено: {new Date(proof.created_at).toLocaleString('ru-RU')}</p>
                          <span className={`inline-flex rounded-full px-2 py-1 text-xs font-medium mt-2 ${badge.className}`}>
                            {badge.label}
                          </span>
                        </div>
                        {proof.status === 'pending' ? (
                          <div className="flex items-center gap-2">
                            <button
                              onClick={() => updateStatus(proof.id, 'approved')}
                              className="flex h-9 items-center gap-1 rounded-md bg-green-500/20 px-3 text-sm font-medium text-green-500 hover:bg-green-500/30 disabled:opacity-60"
                              disabled={isUpdating}
                              type="button"
                            >
                              <span className="material-symbols-outlined text-base">check_circle</span>
                              <span>Подтвердить</span>
                            </button>
                            <button
                              onClick={() => updateStatus(proof.id, 'rejected')}
                              className="flex h-9 items-center gap-1 rounded-md bg-red-500/20 px-3 text-sm font-medium text-red-500 hover:bg-red-500/30 disabled:opacity-60"
                              disabled={isUpdating}
                              type="button"
                            >
                              <span className="material-symbols-outlined text-base">cancel</span>
                              <span>Отклонить</span>
                            </button>
                          </div>
                        ) : null}
                      </div>
                    </div>
                  )
                })
              )}
            </div>
          </section>
        </div>
      </main>
    </div>
  )
}
