import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router'
import type { TelegramUser } from '../types/telegram'
import type { PaymentProof } from '../types/payment'
import { buildAuthHeaders, getStoredUser } from '../utils/auth'
import { isAdminUserId } from '../utils/admin'

interface AuthenticatedUser extends TelegramUser {
  token: string
}

function statusIcon(status: PaymentProof['status']): { icon: string; className: string; label: string } {
  if (status === 'approved') {
    return { icon: 'check_circle', className: 'text-green-500', label: 'Подтверждено' }
  }
  if (status === 'rejected') {
    return { icon: 'cancel', className: 'text-red-500', label: 'Отклонено' }
  }
  return { icon: 'schedule', className: 'text-gray-400', label: 'Ожидание' }
}

export default function ProfilePay() {
  const navigate = useNavigate()
  const [user] = useState<AuthenticatedUser | null>(() => getStoredUser() as AuthenticatedUser | null)
  const [items, setItems] = useState<PaymentProof[]>([])
  const [selectedFile, setSelectedFile] = useState<File | null>(null)
  const [isUploading, setIsUploading] = useState(false)
  const [error, setError] = useState('')
  const [imageUrls, setImageUrls] = useState<Record<number, string>>({})
  const [previewUrl, setPreviewUrl] = useState<string | null>(null)
  const imageBlobUrlsRef = useRef<string[]>([])

  const canViewAdminPanel = useMemo(() => (user ? isAdminUserId(user.id) : false), [user])

  const loadMyProofs = useCallback(async () => {
    if (!user) {
      return
    }
    const res = await fetch('/api/payment-proofs/', {
      headers: buildAuthHeaders(user),
    })
    if (!res.ok) {
      throw new Error('Не удалось загрузить историю отправок')
    }
    const data = (await res.json()) as { items: PaymentProof[] }
    setItems(data.items)
  }, [user])

  useEffect(() => {
    if (!user) {
      navigate('/auth')
      return
    }

    loadMyProofs().catch((e: unknown) => setError(e instanceof Error ? e.message : 'Ошибка загрузки'))
    const intervalId = setInterval(() => {
      loadMyProofs().catch(() => {
        // ������ �������������� ���������� ����������, ����� �� �������� ���������.
      })
    }, 5000)

    return () => clearInterval(intervalId)
  }, [navigate, user, loadMyProofs])

  useEffect(() => {
    if (!user || items.length === 0) {
      setImageUrls({})
      return
    }
    const authUser = user as TelegramUser

    let cancelled = false
    const controllers: AbortController[] = []

    async function loadImages() {
      const next: Record<number, string> = {}
      for (const item of items) {
        const controller = new AbortController()
        controllers.push(controller)
        const res = await fetch(item.file_url, {
          headers: buildAuthHeaders(authUser),
          signal: controller.signal,
        })
        if (!res.ok) {
          continue
        }
        const blob = await res.blob()
        const url = URL.createObjectURL(blob)
        imageBlobUrlsRef.current.push(url)
        next[item.id] = url
      }
      if (!cancelled) {
        setImageUrls(next)
      }
    }

    loadImages().catch(() => {
      // ���� ���������� ������ �������� �����������.
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
  }, [items, user])

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        setPreviewUrl(null)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  if (!user) {
    return <div>Loading...</div>
  }

  async function handleUpload(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!user) {
      return
    }
    const authUser = user as TelegramUser
    if (!selectedFile) {
      setError('Выберите файл перед отправкой')
      return
    }

    setError('')
    setIsUploading(true)
    try {
      const formData = new FormData()
      formData.append('file', selectedFile)
      const res = await fetch('/api/payment-proofs/', {
        method: 'POST',
        headers: buildAuthHeaders(authUser),
        body: formData,
      })

      if (!res.ok) {
        const payload = (await res.json().catch(() => ({ error: 'Ошибка отправки' }))) as { error?: string }
        throw new Error(payload.error || 'Ошибка отправки')
      }

      setSelectedFile(null)
      await loadMyProofs()
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Ошибка отправки')
    } finally {
      setIsUploading(false)
    }
  }

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

      <main className="flex-1 p-6 lg:p-10 overflow-y-auto">
        <div className="max-w-4xl mx-auto flex flex-col gap-6">
          <div className="flex flex-col gap-1">
            <p className="text-gray-900 dark:text-white text-4xl font-black leading-tight tracking-[-0.033em]">Проверка оплаты</p>
            <p className="text-gray-500 dark:text-[#92a4c9] text-base font-normal leading-normal">
              Загрузите фото оплаты. Ниже история всех ваших отправок.
            </p>
          </div>

          <div className="bg-white dark:bg-[#111722] rounded-xl border border-gray-200 dark:border-[#324467] p-6">
            <form className="flex flex-col gap-4" onSubmit={handleUpload}>
              <input
                accept=".jpg,.jpeg,.png,.webp,.bmp,.heic,.svg"
                className="block w-full text-sm text-gray-700 dark:text-gray-300 file:mr-4 file:rounded-lg file:border-0 file:bg-primary file:px-4 file:py-2 file:text-white hover:file:bg-primary/90"
                type="file"
                onChange={(event) => setSelectedFile(event.target.files?.[0] ?? null)}
              />
              <button
                className="flex w-full items-center justify-center gap-2 rounded-lg h-11 px-4 bg-primary text-white text-sm font-bold hover:bg-primary/90 disabled:opacity-60"
                disabled={isUploading}
                type="submit"
              >
                <span className="material-symbols-outlined text-base">send</span>
                <span>{isUploading ? 'Отправка...' : 'Отправить фото'}</span>
              </button>
              {error ? <p className="text-sm text-red-500">{error}</p> : null}
            </form>
          </div>

          <div className="bg-white dark:bg-[#111722] rounded-xl border border-gray-200 dark:border-[#324467] p-6">
            <h2 className="text-gray-900 dark:text-white text-lg font-bold mb-4">История сообщений</h2>
            <div className="flex flex-col gap-4">
              {items.length === 0 ? (
                <p className="text-sm text-gray-500 dark:text-[#92a4c9]">Пока нет отправленных фотографий.</p>
              ) : (
                items.map((item) => {
                  const status = statusIcon(item.status)
                  return (
                    <div key={item.id} className="flex items-start gap-3 justify-end">
                      <div className="max-w-[75%] rounded-xl border border-gray-200 dark:border-[#324467] p-3 bg-gray-50 dark:bg-[#1a2539]">
                        {!imageUrls[item.id] ? (
                          <div className="w-full h-48 rounded-lg mb-2 bg-gray-200/40 dark:bg-[#0f172a] animate-pulse" />
                        ) : (
                          <button className="w-full" onClick={() => setPreviewUrl(imageUrls[item.id])} type="button">
                            <img
                              alt={`proof-${item.id}`}
                              className="w-full max-h-80 object-contain rounded-lg mb-2"
                              src={imageUrls[item.id]}
                            />
                          </button>
                        )}
                        <div className="flex items-center justify-between gap-3">
                          <p className="text-xs text-gray-500 dark:text-[#92a4c9]">
                            {new Date(item.created_at).toLocaleString('ru-RU')}
                          </p>
                          <div className={`flex items-center gap-1 text-sm ${status.className}`}>
                            <span className="material-symbols-outlined text-base">{status.icon}</span>
                            <span>{status.label}</span>
                          </div>
                        </div>
                      </div>
                    </div>
                  )
                })
              )}
            </div>
          </div>
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
