import type { FormEvent, PointerEvent as ReactPointerEvent, SyntheticEvent } from 'react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router'
import { useChatUnreadPing } from '../hooks/useChatUnreadPing'
import type { AuthUser } from '../types/auth'
import type { ProfileSettingsPayload } from '../types/profile'
import type { TelegramUser } from '../types/telegram'
import { isAdminUser } from '../utils/admin'
import {
  buildAuthHeaders,
  bumpStoredAvatarVersion,
  clearStoredAuth,
  getStoredUser,
  storeAuthUser,
  withStoredAvatarVersion,
} from '../utils/auth'
import { getAvatarImageStyle, normalizeAvatarPresentation } from '../utils/avatar'

const DEFAULT_AVATAR =
  'https://lh3.googleusercontent.com/aida-public/AB6AXuD7QfEnuqRCntNYH9h2Vpo3jzR2BMfMqxHuHq-ivlguZcwzF_lfmadLZHf4vT8CfrKoIUNDPR1MmHqWK_suVK1pQOJXx0sSYBdAc3HCdZbWyuwNnuAj95xWWZilTRSMiKUfTt-6lFPSIvaV577Wik1oYO_ONDLJYuA5yaDJJSU7PwQfDQftZAILVh17O3KQr1s3dq56Z1g5mUvalbeTkomtJfUowYTnX-9km8Hdzb5Wm8IyfcVbawTAHqT3EkFdUrXJHLDkkTopp-E'
const TELEGRAM_BOT_NAME = import.meta.env.VITE_TELEGRAM_BOT_NAME
const MIN_AVATAR_SCALE = 1
const MAX_AVATAR_SCALE = 3
const MIN_AVATAR_POSITION = 0
const MAX_AVATAR_POSITION = 100

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}

declare global {
  interface Window {
    onTelegramProfileLink?: (user: TelegramUser) => void
  }
}

function getDisplayName(user: AuthUser): string {
  return user.display_name || user.username || user.telegram_username || user.email || 'Пользователь'
}

function getTelegramId(user: AuthUser): number | null {
  if (typeof user.telegram_id === 'number' && Number.isFinite(user.telegram_id)) {
    return user.telegram_id
  }
  return null
}

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

async function parseApiError(response: Response, fallback: string): Promise<string> {
  const payload = (await response.json().catch(() => null)) as { error?: string } | null
  return payload?.error || fallback
}

function mergeUserWithProfilePayload(user: AuthUser, payload: ProfileSettingsPayload | AuthUser): AuthUser {
  const nextTelegramId =
    typeof payload.telegram_id === 'number'
      ? payload.telegram_id
      : payload.telegram_id === null
        ? undefined
        : user.telegram_id

  return {
    ...user,
    display_name: payload.display_name ?? user.display_name,
    username: payload.username ?? user.username,
    photo: payload.photo ?? user.photo,
    email: payload.email ?? user.email,
    telegram_id: nextTelegramId,
    telegram_username: payload.telegram_username ?? user.telegram_username,
    avatar_scale: typeof payload.avatar_scale === 'number' ? payload.avatar_scale : user.avatar_scale,
    avatar_position_x: typeof payload.avatar_position_x === 'number' ? payload.avatar_position_x : user.avatar_position_x,
    avatar_position_y: typeof payload.avatar_position_y === 'number' ? payload.avatar_position_y : user.avatar_position_y,
    auth_provider:
      payload.auth_provider === 'telegram' || payload.auth_provider === 'email' ? payload.auth_provider : user.auth_provider,
    has_email_auth: typeof payload.has_email_auth === 'boolean' ? payload.has_email_auth : user.has_email_auth,
    has_telegram_auth: typeof payload.has_telegram_auth === 'boolean' ? payload.has_telegram_auth : user.has_telegram_auth,
    can_link_email: typeof payload.can_link_email === 'boolean' ? payload.can_link_email : user.can_link_email,
    can_link_telegram: typeof payload.can_link_telegram === 'boolean' ? payload.can_link_telegram : user.can_link_telegram,
  }
}

function isSameUserSnapshot(current: AuthUser, next: AuthUser): boolean {
  return (
    current.display_name === next.display_name &&
    current.username === next.username &&
    current.photo === next.photo &&
    current.email === next.email &&
    current.telegram_id === next.telegram_id &&
    current.telegram_username === next.telegram_username &&
    current.avatar_scale === next.avatar_scale &&
    current.avatar_position_x === next.avatar_position_x &&
    current.avatar_position_y === next.avatar_position_y &&
    current.auth_provider === next.auth_provider &&
    current.has_email_auth === next.has_email_auth &&
    current.has_telegram_auth === next.has_telegram_auth &&
    current.can_link_email === next.can_link_email &&
    current.can_link_telegram === next.can_link_telegram
  )
}

export default function ProfileSettings() {
  const navigate = useNavigate()
  const [user, setUser] = useState<AuthUser | null>(() => getStoredUser())
  const { totalUnread } = useChatUnreadPing(user)
  const [profileDisplayName, setProfileDisplayName] = useState('')
  const [avatarFile, setAvatarFile] = useState<File | null>(null)
  const [removeAvatar, setRemoveAvatar] = useState(false)
  const [avatarPreviewUrl, setAvatarPreviewUrl] = useState('')
  const [avatarScale, setAvatarScale] = useState(1)
  const [avatarPositionX, setAvatarPositionX] = useState(50)
  const [avatarPositionY, setAvatarPositionY] = useState(50)
  const [isLoadingSettings, setIsLoadingSettings] = useState(true)
  const [isSavingProfile, setIsSavingProfile] = useState(false)
  const [profileError, setProfileError] = useState('')
  const [profileNotice, setProfileNotice] = useState('')
  const [linkEmail, setLinkEmail] = useState('')
  const [linkEmailPassword, setLinkEmailPassword] = useState('')
  const [linkEmailConfirmPassword, setLinkEmailConfirmPassword] = useState('')
  const [isLinkingEmail, setIsLinkingEmail] = useState(false)
  const [isLinkingTelegram, setIsLinkingTelegram] = useState(false)
  const [linkError, setLinkError] = useState('')
  const [linkNotice, setLinkNotice] = useState('')
  const [isAvatarDragging, setIsAvatarDragging] = useState(false)
  const avatarEditorRef = useRef<HTMLDivElement | null>(null)
  const dragPointerIdRef = useRef<number | null>(null)
  const dragStartRef = useRef<{ clientX: number; clientY: number; startPositionX: number; startPositionY: number } | null>(
    null
  )

  const canViewAdminPanel = Boolean(user && isAdminUser(user))

  const handleUnauthorized = useCallback(() => {
    clearStoredAuth()
    navigate('/auth')
  }, [navigate])

  const loadProfileSettings = useCallback(async () => {
    if (!user) {
      return
    }

    setIsLoadingSettings(true)
    try {
      const response = await fetch('/api/profile/settings/', {
        headers: buildAuthHeaders(user),
      })
      if (response.status === 401 || response.status === 403) {
        handleUnauthorized()
        return
      }
      if (!response.ok) {
        setProfileError(await parseApiError(response, 'Не удалось загрузить настройки профиля'))
        return
      }

      const payload = (await response.json()) as ProfileSettingsPayload
      setProfileDisplayName(payload.display_name || payload.username || '')
      const nextUser = mergeUserWithProfilePayload(user, payload)
      const avatarPresentation = normalizeAvatarPresentation(payload)
      setAvatarScale(avatarPresentation.avatar_scale)
      setAvatarPositionX(avatarPresentation.avatar_position_x)
      setAvatarPositionY(avatarPresentation.avatar_position_y)
      if (!isSameUserSnapshot(user, nextUser)) {
        storeAuthUser(nextUser)
        setUser(nextUser)
      }
      setLinkEmail(payload.email || '')
      setProfileError('')
    } catch {
      setProfileError('Сетевая ошибка при загрузке настроек профиля')
    } finally {
      setIsLoadingSettings(false)
    }
  }, [handleUnauthorized, user])

  useEffect(() => {
    if (!user) {
      navigate('/auth')
    }
  }, [navigate, user])

  useEffect(() => {
    loadProfileSettings().catch(() => {
      setProfileError('Не удалось загрузить настройки профиля')
      setIsLoadingSettings(false)
    })
  }, [loadProfileSettings])

  useEffect(() => {
    if (!avatarFile) {
      setAvatarPreviewUrl('')
      return
    }
    const nextObjectUrl = URL.createObjectURL(avatarFile)
    setAvatarPreviewUrl(nextObjectUrl)
    return () => {
      URL.revokeObjectURL(nextObjectUrl)
    }
  }, [avatarFile])

  useEffect(() => {
    if (!user) {
      return
    }

    const canLinkTelegramForSession =
      user.auth_provider === 'email' && (user.can_link_telegram ?? !(user.has_telegram_auth ?? Boolean(user.telegram_id)))
    if (!canLinkTelegramForSession) {
      return
    }

    window.onTelegramProfileLink = async (telegramUser: TelegramUser) => {
      setIsLinkingTelegram(true)
      setLinkError('')
      setLinkNotice('')

      try {
        const response = await fetch('/api/auth/link/telegram/', {
          method: 'POST',
          headers: {
            ...buildAuthHeaders(user),
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(telegramUser),
        })

        if (response.status === 401 || response.status === 403) {
          handleUnauthorized()
          return
        }
        if (!response.ok) {
          setLinkError(await parseApiError(response, 'Не удалось привязать Telegram'))
          return
        }

        const payload = (await response.json()) as AuthUser
        const nextUser = mergeUserWithProfilePayload(user, payload)
        storeAuthUser(nextUser)
        setUser(nextUser)
        setLinkNotice('Telegram успешно привязан')
      } catch {
        setLinkError('Сетевая ошибка при привязке Telegram')
      } finally {
        setIsLinkingTelegram(false)
      }
    }

    const container = document.getElementById('telegram-link-widget')
    if (!container) {
      return () => {
        delete window.onTelegramProfileLink
      }
    }

    container.innerHTML = ''
    if (!TELEGRAM_BOT_NAME) {
      return () => {
        container.innerHTML = ''
        delete window.onTelegramProfileLink
      }
    }

    const script = document.createElement('script')
    script.src = 'https://telegram.org/js/telegram-widget.js?22'
    script.async = true
    script.setAttribute('data-telegram-login', TELEGRAM_BOT_NAME)
    script.setAttribute('data-size', 'large')
    script.setAttribute('data-radius', '0')
    script.setAttribute('data-userpic', 'true')
    script.setAttribute('data-request-access', 'write')
    script.setAttribute('data-onauth', 'onTelegramProfileLink(user)')
    container.appendChild(script)

    return () => {
      container.innerHTML = ''
      delete window.onTelegramProfileLink
    }
  }, [handleUnauthorized, user])

  if (!user) {
    return <div>Загрузка...</div>
  }

  const displayName = getDisplayName(user)
  const telegramId = getTelegramId(user)
  const avatarUrl = getAvatarUrl(user.photo)
  const hasEmailAuth = user.has_email_auth ?? Boolean(user.email)
  const hasTelegramAuth = user.has_telegram_auth ?? telegramId !== null
  const canLinkEmail = user.can_link_email ?? !hasEmailAuth
  const canLinkTelegram = user.can_link_telegram ?? !hasTelegramAuth
  const showTelegramLinkSection = user.auth_provider === 'email' && canLinkTelegram
  const showEmailLinkSection = user.auth_provider === 'telegram' && canLinkEmail
  const allAuthMethodsLinked = hasEmailAuth && hasTelegramAuth
  const draftDisplayName = profileDisplayName.trim() || displayName
  const draftAvatarUrl = removeAvatar ? DEFAULT_AVATAR : avatarPreviewUrl || avatarUrl || DEFAULT_AVATAR
  const draftAvatarStyle = getAvatarImageStyle({
    avatar_scale: avatarScale,
    avatar_position_x: avatarPositionX,
    avatar_position_y: avatarPositionY,
  })

  function stopAvatarDragging() {
    dragPointerIdRef.current = null
    dragStartRef.current = null
    setIsAvatarDragging(false)
  }

  function handleAvatarEditorPointerDown(event: ReactPointerEvent<HTMLDivElement>) {
    if (removeAvatar) {
      return
    }
    event.preventDefault()
    dragPointerIdRef.current = event.pointerId
    dragStartRef.current = {
      clientX: event.clientX,
      clientY: event.clientY,
      startPositionX: avatarPositionX,
      startPositionY: avatarPositionY,
    }
    event.currentTarget.setPointerCapture(event.pointerId)
    setIsAvatarDragging(true)
  }

  function handleAvatarEditorPointerMove(event: ReactPointerEvent<HTMLDivElement>) {
    if (dragPointerIdRef.current !== event.pointerId || !dragStartRef.current) {
      return
    }
    const editorElement = avatarEditorRef.current
    if (!editorElement) {
      return
    }

    const bounds = editorElement.getBoundingClientRect()
    const editorSize = Math.max(1, Math.min(bounds.width, bounds.height))
    const deltaX = event.clientX - dragStartRef.current.clientX
    const deltaY = event.clientY - dragStartRef.current.clientY
    const sensitivity = 100 / editorSize / Math.max(avatarScale, MIN_AVATAR_SCALE)

    const nextPositionX = clamp(
      dragStartRef.current.startPositionX - deltaX * sensitivity,
      MIN_AVATAR_POSITION,
      MAX_AVATAR_POSITION
    )
    const nextPositionY = clamp(
      dragStartRef.current.startPositionY - deltaY * sensitivity,
      MIN_AVATAR_POSITION,
      MAX_AVATAR_POSITION
    )

    setAvatarPositionX(nextPositionX)
    setAvatarPositionY(nextPositionY)
  }

  function handleAvatarEditorPointerUp(event: ReactPointerEvent<HTMLDivElement>) {
    if (dragPointerIdRef.current !== event.pointerId) {
      return
    }
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
    stopAvatarDragging()
  }

  function handleAvatarEditorPointerCancel(event: ReactPointerEvent<HTMLDivElement>) {
    if (dragPointerIdRef.current !== event.pointerId) {
      return
    }
    stopAvatarDragging()
  }

  function resetAvatarPresentation() {
    setAvatarScale(1)
    setAvatarPositionX(50)
    setAvatarPositionY(50)
  }

  async function handleSaveProfileSettings(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!user) {
      return
    }

    const normalizedDisplayName = profileDisplayName.trim()
    const formData = new FormData()
    formData.append('display_name', normalizedDisplayName)
    formData.append('avatar_scale', String(avatarScale))
    formData.append('avatar_position_x', String(Math.round(avatarPositionX)))
    formData.append('avatar_position_y', String(Math.round(avatarPositionY)))
    if (avatarFile) {
      formData.append('avatar', avatarFile)
    }
    if (removeAvatar) {
      formData.append('remove_avatar', 'true')
    }

    setIsSavingProfile(true)
    setProfileError('')
    setProfileNotice('')

    try {
      const response = await fetch('/api/profile/settings/', {
        method: 'POST',
        headers: buildAuthHeaders(user),
        body: formData,
      })
      if (response.status === 401 || response.status === 403) {
        handleUnauthorized()
        return
      }
      if (!response.ok) {
        setProfileError(await parseApiError(response, 'Не удалось сохранить настройки профиля'))
        return
      }

      const payload = (await response.json()) as ProfileSettingsPayload
      const avatarUpdated = Boolean(avatarFile || removeAvatar)
      if (avatarUpdated) {
        bumpStoredAvatarVersion()
      }
      const avatarPresentation = normalizeAvatarPresentation(payload)
      setAvatarScale(avatarPresentation.avatar_scale)
      setAvatarPositionX(avatarPresentation.avatar_position_x)
      setAvatarPositionY(avatarPresentation.avatar_position_y)

      const nextUser = mergeUserWithProfilePayload(user, payload)
      storeAuthUser(nextUser)
      setUser(nextUser)
      setProfileDisplayName(payload.display_name || payload.username || '')
      setLinkEmail(payload.email || nextUser.email || '')

      setAvatarFile(null)
      setRemoveAvatar(false)
      setProfileNotice('Профиль обновлён')
    } catch {
      setProfileError('Сетевая ошибка при сохранении профиля')
    } finally {
      setIsSavingProfile(false)
    }
  }

  function handleLogout() {
    clearStoredAuth()
    navigate('/auth')
  }

  function handleProfileClick() {
    navigate('/profile')
  }

  function handleProfilePayClick() {
    navigate('/profile-pay')
  }

  function handleAdminPanelClick() {
    navigate('/admin')
  }

  function handleChatClick() {
    navigate('/chat')
  }

  async function handleLinkEmailSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!user) {
      return
    }

    const normalizedEmail = linkEmail.trim().toLowerCase()
    if (!normalizedEmail || !linkEmailPassword) {
      setLinkError('Введите email и пароль')
      return
    }
    if (linkEmailPassword !== linkEmailConfirmPassword) {
      setLinkError('Пароли не совпадают')
      return
    }

    setIsLinkingEmail(true)
    setLinkError('')
    setLinkNotice('')
    try {
      const response = await fetch('/api/auth/link/email/', {
        method: 'POST',
        headers: {
          ...buildAuthHeaders(user),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ email: normalizedEmail, password: linkEmailPassword }),
      })
      if (response.status === 401 || response.status === 403) {
        handleUnauthorized()
        return
      }
      if (!response.ok) {
        setLinkError(await parseApiError(response, 'Не удалось привязать email'))
        return
      }

      const payload = (await response.json()) as AuthUser
      const nextUser = mergeUserWithProfilePayload(user, payload)
      storeAuthUser(nextUser)
      setUser(nextUser)
      setLinkEmail(nextUser.email || normalizedEmail)
      setLinkEmailPassword('')
      setLinkEmailConfirmPassword('')
      setLinkNotice('Email успешно привязан')
    } catch {
      setLinkError('Сетевая ошибка при привязке email')
    } finally {
      setIsLinkingEmail(false)
    }
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
                    alt={draftDisplayName}
                    className="size-10 rounded-full object-cover object-center"
                    onError={handleAvatarError}
                    src={draftAvatarUrl}
                    style={draftAvatarStyle}
                  />
                </div>
                <div className="flex flex-col">
                  <h1 className="text-base font-medium leading-normal text-gray-900 dark:text-white">{draftDisplayName}</h1>
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
                <button
                  className="cursor-pointer rounded-lg px-3 py-2 text-left hover:bg-gray-100 dark:hover:bg-gray-800/50"
                  onClick={handleProfileClick}
                  type="button"
                >
                  <div className="flex items-center gap-3">
                    <span className="material-symbols-outlined text-gray-500 dark:text-white">dashboard</span>
                    <p className="text-sm font-medium leading-normal text-gray-700 dark:text-white">Панель управления</p>
                  </div>
                </button>
                <button
                  className="cursor-pointer rounded-lg px-3 py-2 text-left hover:bg-gray-100 dark:hover:bg-gray-800/50"
                  onClick={handleChatClick}
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
                {canViewAdminPanel ? (
                  <button
                    className="cursor-pointer rounded-lg px-3 py-2 text-left hover:bg-gray-100 dark:hover:bg-gray-800/50"
                    onClick={handleAdminPanelClick}
                    type="button"
                  >
                    <div className="flex items-center gap-3">
                      <span className="material-symbols-outlined text-gray-500 dark:text-white">admin_panel_settings</span>
                      <p className="text-sm font-medium leading-normal text-gray-700 dark:text-white">Админ-панель</p>
                    </div>
                  </button>
                ) : null}
                <a className="flex items-center gap-3 rounded-lg bg-primary/10 px-3 py-2 dark:bg-[#232f48]" href="#">
                  <span className="material-symbols-outlined text-primary dark:text-white">manage_accounts</span>
                  <p className="text-sm font-medium leading-normal text-primary dark:text-white">Настройки профиля</p>
                </a>
                <button
                  className="cursor-pointer rounded-lg px-3 py-2 text-left hover:bg-gray-100 dark:hover:bg-gray-800/50"
                  onClick={handleProfilePayClick}
                  type="button"
                >
                  <div className="flex items-center gap-3">
                    <span className="material-symbols-outlined text-gray-500 dark:text-white">payment</span>
                    <p className="text-sm font-medium leading-normal text-gray-700 dark:text-white">Оплата</p>
                  </div>
                </button>
              </nav>
            </div>
          </div>
          <div className="flex flex-col gap-4">
            <button
              className="flex h-10 w-full cursor-pointer items-center justify-center overflow-hidden rounded-lg bg-primary px-4 text-sm font-bold leading-normal tracking-[0.015em] text-white hover:bg-primary/90"
              onClick={handleLogout}
              type="button"
            >
              <span className="truncate">Выйти</span>
            </button>
          </div>
        </div>
      </aside>

      <main className="flex-1 overflow-y-auto p-4 md:p-6 lg:p-10">
        <div className="mx-auto max-w-4xl">
          <section className="rounded-xl border border-gray-200 bg-white p-6 dark:border-[#324467] dark:bg-[#111722]">
            <h2 className="mb-4 text-lg font-bold text-gray-900 dark:text-white">Настройки профиля</h2>
            <form className="grid grid-cols-1 gap-4 md:grid-cols-2" onSubmit={handleSaveProfileSettings}>
              <div className="md:col-span-2 flex items-center gap-3 rounded-lg border border-gray-200 bg-gray-50 px-4 py-3 dark:border-[#324467] dark:bg-[#0f1728]">
                <div className="size-12 shrink-0 overflow-hidden rounded-full bg-gray-100 dark:bg-[#1a2539]">
                  <img
                    alt={draftDisplayName}
                    className="size-12 rounded-full object-cover object-center"
                    onError={handleAvatarError}
                    src={draftAvatarUrl}
                    style={draftAvatarStyle}
                  />
                </div>
                <div className="text-sm text-gray-600 dark:text-[#92a4c9]">
                  Актуальные имя и аватар применяются в шапке и чатах.
                </div>
              </div>

              <label className="flex flex-col gap-2 md:col-span-2">
                <span className="text-sm font-medium text-gray-700 dark:text-white">Ник в чате</span>
                <input
                  className="h-10 rounded-lg border border-gray-300 bg-white px-3 text-sm text-gray-900 outline-none focus:border-primary dark:border-[#324467] dark:bg-[#0d1525] dark:text-white"
                  maxLength={64}
                  onChange={(event) => setProfileDisplayName(event.target.value)}
                  placeholder="Введите ник"
                  value={profileDisplayName}
                />
              </label>

              <label className="flex flex-col gap-2 md:col-span-2">
                <span className="text-sm font-medium text-gray-700 dark:text-white">Аватар</span>
                <input
                  accept=".jpg,.jpeg,.png,.webp,.bmp,.heic,.svg"
                  className="block w-full text-sm text-gray-700 dark:text-gray-300 file:mr-3 file:rounded-md file:border-0 file:bg-primary file:px-3 file:py-2 file:text-sm file:font-semibold file:text-white hover:file:bg-primary/90"
                  onChange={(event) => {
                    const selectedFile = event.target.files?.[0] ?? null
                    setAvatarFile(selectedFile)
                    if (selectedFile) {
                      setRemoveAvatar(false)
                      resetAvatarPresentation()
                    }
                  }}
                  type="file"
                />
              </label>

              <div className="md:col-span-2 rounded-lg border border-gray-200 bg-gray-50 p-4 dark:border-[#324467] dark:bg-[#0f1728]">
                <p className="text-sm font-medium text-gray-700 dark:text-white">Предпросмотр профиля</p>
                <div className="mt-3 flex flex-col gap-4 md:flex-row md:items-center">
                  <div className="mx-auto size-24 shrink-0 overflow-hidden rounded-full border border-gray-200 bg-white dark:border-[#324467] dark:bg-[#111722] md:mx-0">
                    <img
                      alt={draftDisplayName}
                      className="size-24 rounded-full object-cover object-center"
                      onError={handleAvatarError}
                      src={draftAvatarUrl}
                      style={draftAvatarStyle}
                    />
                  </div>
                  <div className="flex-1">
                    <p className="text-base font-semibold text-gray-900 dark:text-white">{draftDisplayName}</p>
                    <p className="text-xs text-gray-500 dark:text-[#92a4c9]">
                      Так ник и аватар будут выглядеть в профиле и в шапке.
                    </p>
                  </div>
                </div>

                <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-[280px_1fr]">
                  <div className="mx-auto w-full max-w-[280px]">
                    <div
                      ref={avatarEditorRef}
                      className={`relative aspect-square w-full overflow-hidden rounded-xl border border-gray-300 bg-[#0a1220] touch-none select-none dark:border-[#324467] ${
                        isAvatarDragging ? 'cursor-grabbing' : 'cursor-grab'
                      }`}
                      onPointerCancel={handleAvatarEditorPointerCancel}
                      onPointerDown={handleAvatarEditorPointerDown}
                      onPointerMove={handleAvatarEditorPointerMove}
                      onPointerUp={handleAvatarEditorPointerUp}
                      role="presentation"
                    >
                      <img
                        alt={draftDisplayName}
                        className="absolute inset-0 size-full object-cover object-center"
                        draggable={false}
                        onError={handleAvatarError}
                        src={draftAvatarUrl}
                        style={draftAvatarStyle}
                      />
                      <div className="pointer-events-none absolute inset-0 rounded-full border-2 border-white/70" />
                      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_center,transparent_54%,rgba(6,10,18,0.55)_55%)]" />
                    </div>
                    <p className="mt-2 text-xs text-gray-500 dark:text-[#92a4c9]">
                      Перетащите изображение внутри рамки, чтобы выбрать центр аватара.
                    </p>
                  </div>

                  <div className="space-y-3">
                    <label className="flex flex-col gap-1">
                      <span className="text-xs text-gray-600 dark:text-[#92a4c9]">Масштаб: {avatarScale.toFixed(2)}x</span>
                      <input
                        className="accent-primary"
                        max={MAX_AVATAR_SCALE}
                        min={MIN_AVATAR_SCALE}
                        onChange={(event) => setAvatarScale(clamp(Number(event.target.value), MIN_AVATAR_SCALE, MAX_AVATAR_SCALE))}
                        step={0.01}
                        type="range"
                        value={avatarScale}
                      />
                    </label>

                    <div className="grid grid-cols-1 gap-2 text-xs text-gray-600 dark:text-[#92a4c9] sm:grid-cols-2">
                      <p>Позиция X: {Math.round(avatarPositionX)}%</p>
                      <p>Позиция Y: {Math.round(avatarPositionY)}%</p>
                    </div>

                    <button
                      className="h-9 rounded-lg border border-gray-300 px-3 text-xs font-medium text-gray-700 hover:bg-gray-100 dark:border-[#324467] dark:text-white dark:hover:bg-[#1a2539]"
                      onClick={resetAvatarPresentation}
                      type="button"
                    >
                      Сбросить позицию и масштаб
                    </button>
                  </div>
                </div>
              </div>

              <label className="inline-flex items-center gap-2 text-sm text-gray-600 dark:text-[#92a4c9] md:col-span-2">
                <input
                  checked={removeAvatar}
                  onChange={(event) => {
                    setRemoveAvatar(event.target.checked)
                    if (event.target.checked) {
                      setAvatarFile(null)
                    }
                  }}
                  type="checkbox"
                />
                Удалить текущий аватар
              </label>

              <div className="md:col-span-2">
                {profileError ? <p className="text-sm text-red-500">{profileError}</p> : null}
                {profileNotice ? <p className="text-sm text-green-600">{profileNotice}</p> : null}
                {isLoadingSettings ? <p className="text-sm text-gray-500 dark:text-[#92a4c9]">Загрузка настроек...</p> : null}
              </div>

              <div className="md:col-span-2">
                <button
                  className="h-10 rounded-lg bg-primary px-4 text-sm font-semibold text-white hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-60"
                  disabled={isSavingProfile || isLoadingSettings}
                  type="submit"
                >
                  {isSavingProfile ? 'Сохранение...' : 'Сохранить профиль'}
                </button>
              </div>
            </form>

            {showTelegramLinkSection ? (
              <div className="mt-6 rounded-xl border border-gray-200 bg-gray-50 p-4 dark:border-[#324467] dark:bg-[#0f1728]">
                <h3 className="text-base font-semibold text-gray-900 dark:text-white">Привязка Telegram</h3>
                <p className="mt-1 text-sm text-gray-600 dark:text-[#92a4c9]">
                  Войдите через Telegram, чтобы привязать Telegram-аккаунт к текущему email-профилю.
                </p>
                <div
                  id="telegram-link-widget"
                  style={{
                    display: 'flex',
                    justifyContent: 'center',
                    minHeight: '56px',
                    marginTop: '12px',
                  }}
                />
                {!TELEGRAM_BOT_NAME ? (
                  <p className="mt-2 text-sm text-gray-500 dark:text-[#92a4c9]">
                    Telegram-вход скрыт, потому что не настроен `VITE_TELEGRAM_BOT_NAME`.
                  </p>
                ) : null}
                {isLinkingTelegram ? <p className="mt-2 text-sm text-gray-500 dark:text-[#92a4c9]">Привязываем Telegram...</p> : null}
              </div>
            ) : null}

            {showEmailLinkSection ? (
              <form className="mt-6 grid grid-cols-1 gap-3 rounded-xl border border-gray-200 bg-gray-50 p-4 dark:border-[#324467] dark:bg-[#0f1728]" onSubmit={handleLinkEmailSubmit}>
                <h3 className="text-base font-semibold text-gray-900 dark:text-white">Привязка Email</h3>
                <p className="text-sm text-gray-600 dark:text-[#92a4c9]">
                  Зарегистрируйте email и пароль, чтобы привязать email-вход к текущему Telegram-профилю.
                </p>

                <label className="flex flex-col gap-1">
                  <span className="text-sm text-gray-700 dark:text-white">Email</span>
                  <input
                    className="h-10 rounded-lg border border-gray-300 bg-white px-3 text-sm text-gray-900 outline-none focus:border-primary dark:border-[#324467] dark:bg-[#0d1525] dark:text-white"
                    onChange={(event) => setLinkEmail(event.target.value)}
                    placeholder="name@example.com"
                    type="email"
                    value={linkEmail}
                  />
                </label>

                <label className="flex flex-col gap-1">
                  <span className="text-sm text-gray-700 dark:text-white">Пароль</span>
                  <input
                    className="h-10 rounded-lg border border-gray-300 bg-white px-3 text-sm text-gray-900 outline-none focus:border-primary dark:border-[#324467] dark:bg-[#0d1525] dark:text-white"
                    onChange={(event) => setLinkEmailPassword(event.target.value)}
                    placeholder="Минимум 6 символов"
                    type="password"
                    value={linkEmailPassword}
                  />
                </label>

                <label className="flex flex-col gap-1">
                  <span className="text-sm text-gray-700 dark:text-white">Подтверждение пароля</span>
                  <input
                    className="h-10 rounded-lg border border-gray-300 bg-white px-3 text-sm text-gray-900 outline-none focus:border-primary dark:border-[#324467] dark:bg-[#0d1525] dark:text-white"
                    onChange={(event) => setLinkEmailConfirmPassword(event.target.value)}
                    placeholder="Повторите пароль"
                    type="password"
                    value={linkEmailConfirmPassword}
                  />
                </label>

                <div>
                  <button
                    className="h-10 rounded-lg bg-primary px-4 text-sm font-semibold text-white hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-60"
                    disabled={isLinkingEmail}
                    type="submit"
                  >
                    {isLinkingEmail ? 'Привязка...' : 'Привязать email'}
                  </button>
                </div>
              </form>
            ) : null}

            {allAuthMethodsLinked ? (
              <p className="mt-6 text-sm text-gray-600 dark:text-[#92a4c9]">Оба способа входа уже привязаны к одному аккаунту.</p>
            ) : null}
            {linkError ? <p className="mt-3 text-sm text-red-500">{linkError}</p> : null}
            {linkNotice ? <p className="mt-3 text-sm text-green-600">{linkNotice}</p> : null}
          </section>
        </div>
      </main>
    </div>
  )
}
