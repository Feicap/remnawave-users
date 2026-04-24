import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router'
import type { AuthUser } from '../types/auth'
import type { UserNotification } from '../types/notification'
import { useNotifications } from '../hooks/useNotifications'

function formatNotificationTime(value: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) {
    return ''
  }
  return date.toLocaleString('ru-RU', {
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })
}

function kindIcon(kind: UserNotification['kind']): string {
  if (kind === 'payment') {
    return 'payments'
  }
  if (kind === 'chat') {
    return 'chat'
  }
  if (kind === 'account') {
    return 'manage_accounts'
  }
  return 'notifications'
}

export default function NotificationBell({ user }: { user: AuthUser | null }) {
  const navigate = useNavigate()
  const [isOpen, setIsOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement | null>(null)
  const { items, unreadCount, isLoading, markAllRead } = useNotifications(user)

  useEffect(() => {
    function onPointerDown(event: MouseEvent) {
      if (!rootRef.current || rootRef.current.contains(event.target as Node)) {
        return
      }
      setIsOpen(false)
    }

    window.addEventListener('mousedown', onPointerDown)
    return () => window.removeEventListener('mousedown', onPointerDown)
  }, [])

  function openNotification(notification: UserNotification) {
    if (notification.link_url) {
      navigate(notification.link_url)
    }
    setIsOpen(false)
  }

  return (
    <div className="relative" ref={rootRef}>
      <button
        aria-label="Уведомления"
        className="relative inline-flex h-10 w-10 items-center justify-center rounded-lg border border-gray-200 bg-white text-gray-700 hover:bg-gray-50 dark:border-[#324467] dark:bg-[#111722] dark:text-white dark:hover:bg-[#1a2539]"
        onClick={() => setIsOpen((current) => !current)}
        type="button"
      >
        <span className="material-symbols-outlined text-[22px]">notifications</span>
        {unreadCount > 0 ? (
          <span className="absolute -right-1 -top-1 inline-flex min-w-5 items-center justify-center rounded-full bg-red-500 px-1 text-[10px] font-semibold text-white">
            {unreadCount > 99 ? '99+' : unreadCount}
          </span>
        ) : null}
      </button>

      {isOpen ? (
        <div className="absolute right-0 z-40 mt-2 w-[min(92vw,360px)] rounded-xl border border-gray-200 bg-white shadow-xl dark:border-[#324467] dark:bg-[#111722]">
          <div className="flex items-center justify-between border-b border-gray-100 px-4 py-3 dark:border-[#1e2a40]">
            <p className="text-sm font-semibold text-gray-900 dark:text-white">Уведомления</p>
            <button
              className="text-xs font-medium text-primary hover:text-primary/80 disabled:opacity-50"
              disabled={unreadCount === 0}
              onClick={() => {
                void markAllRead()
              }}
              type="button"
            >
              Прочитано
            </button>
          </div>
          <div className="max-h-96 overflow-y-auto py-1">
            {isLoading && items.length === 0 ? (
              <p className="px-4 py-3 text-sm text-gray-500 dark:text-[#92a4c9]">Загрузка...</p>
            ) : items.length === 0 ? (
              <p className="px-4 py-3 text-sm text-gray-500 dark:text-[#92a4c9]">Новых событий нет.</p>
            ) : (
              items.map((item) => (
                <button
                  className={
                    item.is_read
                      ? 'flex w-full gap-3 px-4 py-3 text-left hover:bg-gray-50 dark:hover:bg-[#1a2539]'
                      : 'flex w-full gap-3 bg-primary/5 px-4 py-3 text-left hover:bg-primary/10 dark:bg-primary/10 dark:hover:bg-primary/15'
                  }
                  key={item.id}
                  onClick={() => openNotification(item)}
                  type="button"
                >
                  <span className="material-symbols-outlined mt-0.5 text-[20px] text-primary">{kindIcon(item.kind)}</span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-semibold text-gray-900 dark:text-white">{item.title}</span>
                    {item.body ? (
                      <span className="mt-0.5 block text-xs text-gray-600 dark:text-[#92a4c9]">{item.body}</span>
                    ) : null}
                    <span className="mt-1 block text-[11px] text-gray-400">{formatNotificationTime(item.created_at)}</span>
                  </span>
                </button>
              ))
            )}
          </div>
        </div>
      ) : null}
    </div>
  )
}
