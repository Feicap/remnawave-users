import { useCallback, useEffect, useRef, useState } from 'react'
import type { AuthUser } from '../types/auth'
import type { NotificationsResponse, UserNotification } from '../types/notification'
import { buildAuthHeaders } from '../utils/auth'
import { useChatRealtime, type ChatRealtimeEvent } from './useChatRealtime'

const DEFAULT_NOTIFICATION_POLL_MS = 15000

export function useNotifications(user: AuthUser | null, enabled: boolean = true) {
  const [items, setItems] = useState<UserNotification[]>([])
  const [unreadCount, setUnreadCount] = useState(0)
  const [isLoading, setIsLoading] = useState(false)
  const refreshTimerRef = useRef<number | null>(null)

  const loadNotifications = useCallback(
    async (showLoader: boolean = false) => {
      if (!user || !enabled) {
        return
      }
      if (showLoader) {
        setIsLoading(true)
      }
      try {
        const response = await fetch('/api/notifications/?limit=20', {
          headers: buildAuthHeaders(user),
        })
        if (!response.ok) {
          return
        }
        const payload = (await response.json()) as NotificationsResponse
        setItems(payload.items)
        setUnreadCount(Math.max(0, Math.floor(payload.unread_count || 0)))
      } finally {
        if (showLoader) {
          setIsLoading(false)
        }
      }
    },
    [enabled, user],
  )

  const scheduleRefresh = useCallback(() => {
    if (refreshTimerRef.current !== null) {
      return
    }
    refreshTimerRef.current = window.setTimeout(() => {
      refreshTimerRef.current = null
      void loadNotifications(false)
    }, 150)
  }, [loadNotifications])

  const handleRealtimeEvent = useCallback(
    (event: ChatRealtimeEvent) => {
      if (event.scope === 'notification') {
        scheduleRefresh()
      }
    },
    [scheduleRefresh],
  )

  useChatRealtime(user, enabled && Boolean(user), handleRealtimeEvent)

  useEffect(() => {
    if (!user || !enabled) {
      setItems([])
      setUnreadCount(0)
      return
    }

    void loadNotifications(true)
    const intervalId = window.setInterval(() => {
      void loadNotifications(false)
    }, DEFAULT_NOTIFICATION_POLL_MS)

    return () => {
      window.clearInterval(intervalId)
    }
  }, [enabled, loadNotifications, user])

  useEffect(() => {
    return () => {
      if (refreshTimerRef.current !== null) {
        window.clearTimeout(refreshTimerRef.current)
      }
    }
  }, [])

  const markAllRead = useCallback(async () => {
    if (!user) {
      return
    }
    const previousItems = items
    const previousUnread = unreadCount
    setItems((current) => current.map((item) => ({ ...item, is_read: true, read_at: item.read_at ?? new Date().toISOString() })))
    setUnreadCount(0)
    try {
      const response = await fetch('/api/notifications/', {
        method: 'PATCH',
        headers: buildAuthHeaders(user),
      })
      if (!response.ok) {
        setItems(previousItems)
        setUnreadCount(previousUnread)
      }
    } catch {
      setItems(previousItems)
      setUnreadCount(previousUnread)
    }
  }, [items, unreadCount, user])

  return { items, unreadCount, isLoading, loadNotifications, markAllRead }
}
