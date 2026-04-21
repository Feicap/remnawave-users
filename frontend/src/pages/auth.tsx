import type { FormEvent } from 'react'
import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router'
import type { AuthUser } from '../types/auth'
import type { TelegramUser } from '../types/telegram'
import { getStoredUser, storeAuthUser } from '../utils/auth'

const TELEGRAM_BOT_NAME = import.meta.env.VITE_TELEGRAM_BOT_NAME

declare global {
  interface Window {
    onTelegramAuth: (user: TelegramUser) => void
  }
}

interface ApiError {
  error?: string
}

function normalizeEmail(value: string): string {
  return value.trim().toLowerCase()
}

async function parseApiError(response: Response, fallback: string): Promise<string> {
  const payload = (await response.json().catch(() => null)) as ApiError | null
  return payload?.error || fallback
}

export default function Auth() {
  const navigate = useNavigate()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [isSubmitting, setIsSubmitting] = useState(false)

  useEffect(() => {
    if (getStoredUser()) {
      navigate('/profile')
      return
    }

    window.onTelegramAuth = async (user: TelegramUser) => {
      setError('')
      setIsSubmitting(true)

      try {
        const res = await fetch('/api/auth/telegram/', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(user),
        })

        if (!res.ok) {
          setError(await parseApiError(res, 'Не удалось войти через Telegram'))
          return
        }

        const data = (await res.json()) as AuthUser
        storeAuthUser(data)
        navigate('/profile')
      } catch {
        setError('Ошибка сети')
      } finally {
        setIsSubmitting(false)
      }
    }

    const container = document.getElementById('telegram-login-widget')
    if (!container || !TELEGRAM_BOT_NAME) {
      return
    }

    container.innerHTML = ''

    const script = document.createElement('script')
    script.src = 'https://telegram.org/js/telegram-widget.js?22'
    script.async = true
    script.setAttribute('data-telegram-login', TELEGRAM_BOT_NAME)
    script.setAttribute('data-size', 'large')
    script.setAttribute('data-radius', '0')
    script.setAttribute('data-userpic', 'true')
    script.setAttribute('data-request-access', 'write')
    script.setAttribute('data-onauth', 'onTelegramAuth(user)')

    container.appendChild(script)

    return () => {
      container.innerHTML = ''
    }
  }, [navigate])

  async function handleEmailSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()

    const normalizedEmail = normalizeEmail(email)
    if (!normalizedEmail || !password) {
      setError('Введите почту и пароль')
      return
    }

    setError('')
    setIsSubmitting(true)

    try {
      const loginRes = await fetch('/api/auth/email/login/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: normalizedEmail, password }),
      })

      if (!loginRes.ok) {
        if (loginRes.status === 404) {
          setError('Аккаунт не зарегистрирован в базе. Нажмите "Регистрация".')
          return
        }
        setError(await parseApiError(loginRes, 'Не удалось войти'))
        return
      }

      const data = (await loginRes.json()) as AuthUser
      storeAuthUser(data)
      navigate('/profile')
    } catch {
      setError('Ошибка сети')
    } finally {
      setIsSubmitting(false)
    }
  }

  function handleRegisterClick() {
    navigate('/auth/create-account', {
      state: {
        email: normalizeEmail(email),
        password,
      },
    })
  }

  return (
    <div className="relative flex min-h-screen w-full flex-col overflow-x-hidden bg-background-light font-display dark:bg-background-dark">
      <div className="layout-container flex h-full grow flex-col">
        <div className="flex flex-1 justify-center px-4 py-5 md:px-10 lg:px-40">
          <div className="layout-content-container flex w-full max-w-[960px] flex-1 flex-col">
            <main className="flex flex-grow items-center justify-center p-4">
              <div className="w-full max-w-4xl @container">
                <div className="flex flex-col overflow-hidden rounded-xl bg-white shadow-sm dark:bg-[#192233] @[768px]:flex-row">
                  <div className="flex w-full min-w-72 grow flex-col justify-center gap-5 p-8 @[768px]:w-1/2">
                    <div className="flex flex-col gap-2">
                      <h1 className="text-sm font-medium leading-normal text-slate-500 dark:text-[#92a4c9]">
                        ОСНОВНОЙ ВХОД
                      </h1>
                      <p className="text-2xl font-bold leading-tight tracking-[-0.015em] text-slate-800 dark:text-white">
                        Войдите по почте и паролю.
                      </p>
                      <p className="text-sm leading-normal text-slate-500 dark:text-[#92a4c9]">
                        Если аккаунт ещё не создан, нажмите кнопку Регистрация.
                      </p>
                    </div>

                    <form className="flex flex-col gap-4" onSubmit={handleEmailSubmit}>
                      <label className="flex flex-col gap-2">
                        <span className="text-sm font-medium text-slate-700 dark:text-white">Почта</span>
                        <input
                          autoComplete="email"
                          className="h-12 rounded-lg border border-slate-200 bg-white px-4 text-slate-900 outline-none transition focus:border-primary dark:border-slate-700 dark:bg-[#111722] dark:text-white"
                          onChange={(event) => setEmail(event.target.value)}
                          placeholder="name@example.com"
                          type="email"
                          value={email}
                        />
                      </label>

                      <label className="flex flex-col gap-2">
                        <span className="text-sm font-medium text-slate-700 dark:text-white">Пароль</span>
                        <input
                          autoComplete="current-password"
                          className="h-12 rounded-lg border border-slate-200 bg-white px-4 text-slate-900 outline-none transition focus:border-primary dark:border-slate-700 dark:bg-[#111722] dark:text-white"
                          onChange={(event) => setPassword(event.target.value)}
                          placeholder="Введите пароль"
                          type="password"
                          value={password}
                        />
                      </label>

                      {error ? <p className="text-sm text-red-500">{error}</p> : null}

                      <div className="flex flex-col gap-3 pt-2 sm:flex-row">
                        <button
                          className="flex h-12 flex-1 items-center justify-center rounded-lg bg-primary px-4 text-sm font-bold tracking-[0.015em] text-white transition hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-60"
                          disabled={isSubmitting}
                          type="submit"
                        >
                          {isSubmitting ? 'Проверяем...' : 'Войти'}
                        </button>
                        <button
                          className="flex h-12 flex-1 items-center justify-center rounded-lg border border-slate-200 px-4 text-sm font-bold text-slate-700 transition hover:bg-slate-50 dark:border-slate-700 dark:text-white dark:hover:bg-[#111722]"
                          disabled={isSubmitting}
                          onClick={handleRegisterClick}
                          type="button"
                        >
                          Регистрация
                        </button>
                      </div>
                    </form>
                  </div>

                  <div className="flex w-full flex-col justify-center gap-4 bg-slate-100 p-8 dark:bg-black/20 @[768px]:w-1/2">
                    <div className="flex flex-col gap-2">
                      <h2 className="text-sm font-medium leading-normal text-slate-500 dark:text-[#92a4c9]">
                        ДОПОЛНИТЕЛЬНО
                      </h2>
                      <p className="text-2xl font-bold leading-tight tracking-[-0.015em] text-slate-800 dark:text-white">
                        Можно войти через Telegram.
                      </p>
                      <p className="text-sm leading-normal text-slate-500 dark:text-[#92a4c9]">
                        Этот способ остаётся доступным как альтернатива основной email-авторизации.
                      </p>
                    </div>

                    <div
                      id="telegram-login-widget"
                      style={{
                        display: 'flex',
                        justifyContent: 'center',
                        minHeight: '56px',
                      }}
                    />

                    {!TELEGRAM_BOT_NAME ? (
                      <p className="text-sm text-slate-500 dark:text-[#92a4c9]">
                        Telegram-вход скрыт, потому что не настроен `VITE_TELEGRAM_BOT_NAME`.
                      </p>
                    ) : null}
                  </div>
                </div>
              </div>
            </main>
          </div>
        </div>
      </div>
    </div>
  )
}
