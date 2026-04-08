import type { FormEvent } from 'react'
import { useEffect, useState } from 'react'
import { useLocation, useNavigate } from 'react-router'
import type { AuthUser } from '../types/auth'
import { getStoredUser, storeAuthUser } from '../utils/auth'

interface LocationState {
  email?: string
  password?: string
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

export default function CreateAccount() {
  const navigate = useNavigate()
  const location = useLocation()
  const state = (location.state as LocationState | null) ?? null
  const [email, setEmail] = useState(state?.email ?? '')
  const [password, setPassword] = useState(state?.password ?? '')
  const [confirmPassword, setConfirmPassword] = useState(state?.password ?? '')
  const [error, setError] = useState('')
  const [isSubmitting, setIsSubmitting] = useState(false)

  useEffect(() => {
    if (getStoredUser()) {
      navigate('/profile')
    }
  }, [navigate])

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()

    const normalizedEmail = normalizeEmail(email)
    if (!normalizedEmail || !password) {
      setError('Введите почту и пароль')
      return
    }

    if (password !== confirmPassword) {
      setError('Пароли не совпадают')
      return
    }

    setError('')
    setIsSubmitting(true)

    try {
      const res = await fetch('/api/auth/email/register/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: normalizedEmail, password }),
      })

      if (!res.ok) {
        setError(await parseApiError(res, 'Не удалось создать аккаунт'))
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

  return (
    <div className="relative flex min-h-screen w-full flex-col overflow-x-hidden bg-background-light font-display dark:bg-background-dark">
      <div className="layout-container flex h-full grow flex-col">
        <div className="flex flex-1 justify-center px-4 py-5 md:px-10 lg:px-40">
          <div className="layout-content-container flex w-full max-w-[720px] flex-1 flex-col">
            <main className="flex flex-grow items-center justify-center p-4">
              <div className="w-full rounded-xl bg-white p-8 shadow-sm dark:bg-[#192233]">
                <div className="mb-6 flex flex-col gap-2">
                  <h1 className="text-sm font-medium leading-normal text-slate-500 dark:text-[#92a4c9]">
                    СОЗДАНИЕ АККАУНТА
                  </h1>
                  <p className="text-2xl font-bold leading-tight tracking-[-0.015em] text-slate-800 dark:text-white">
                    Зарегистрируйте аккаунт по почте.
                  </p>
                  <p className="text-sm leading-normal text-slate-500 dark:text-[#92a4c9]">
                    Эта почта ещё не найдена в базе, поэтому сначала нужно создать аккаунт.
                  </p>
                </div>

                <form className="flex flex-col gap-4" onSubmit={handleSubmit}>
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
                      autoComplete="new-password"
                      className="h-12 rounded-lg border border-slate-200 bg-white px-4 text-slate-900 outline-none transition focus:border-primary dark:border-slate-700 dark:bg-[#111722] dark:text-white"
                      onChange={(event) => setPassword(event.target.value)}
                      placeholder="Не меньше 6 символов"
                      type="password"
                      value={password}
                    />
                  </label>

                  <label className="flex flex-col gap-2">
                    <span className="text-sm font-medium text-slate-700 dark:text-white">Повторите пароль</span>
                    <input
                      autoComplete="new-password"
                      className="h-12 rounded-lg border border-slate-200 bg-white px-4 text-slate-900 outline-none transition focus:border-primary dark:border-slate-700 dark:bg-[#111722] dark:text-white"
                      onChange={(event) => setConfirmPassword(event.target.value)}
                      placeholder="Повторите пароль"
                      type="password"
                      value={confirmPassword}
                    />
                  </label>

                  {error ? <p className="text-sm text-red-500">{error}</p> : null}

                  <div className="flex flex-col gap-3 pt-2 sm:flex-row">
                    <button
                      className="flex h-12 flex-1 items-center justify-center rounded-lg bg-primary px-4 text-sm font-bold tracking-[0.015em] text-white transition hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-60"
                      disabled={isSubmitting}
                      type="submit"
                    >
                      {isSubmitting ? 'Создаём...' : 'Создать аккаунт'}
                    </button>
                    <button
                      className="flex h-12 flex-1 items-center justify-center rounded-lg border border-slate-200 px-4 text-sm font-bold text-slate-700 transition hover:bg-slate-50 dark:border-slate-700 dark:text-white dark:hover:bg-[#111722]"
                      onClick={() => navigate('/auth')}
                      type="button"
                    >
                      Назад ко входу
                    </button>
                  </div>
                </form>
              </div>
            </main>
          </div>
        </div>
      </div>
    </div>
  )
}
