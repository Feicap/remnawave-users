import { useEffect, useState } from 'react'
import type { AuthUser } from '../types/auth'
import type { ChatUnreadSummary } from '../types/chat'
import { buildAuthHeaders } from '../utils/auth'

const CHAT_UNREAD_STORAGE_KEY = 'chat_unread_total'
const DEFAULT_POLL_INTERVAL_MS = 8000

const EMPTY_SUMMARY: ChatUnreadSummary = {
  global_unread: 0,
  private_unread_total: 0,
  private_unread_by_user: [],
  total_unread: 0,
}

function readStoredUnreadCount(): number {
  const raw = localStorage.getItem(CHAT_UNREAD_STORAGE_KEY)
  const parsed = Number(raw)
  if (!Number.isFinite(parsed) || parsed < 0) {
    return 0
  }
  return Math.floor(parsed)
}

export function useChatUnreadPing(user: AuthUser | null, intervalMs: number = DEFAULT_POLL_INTERVAL_MS) {
  const [summary, setSummary] = useState<ChatUnreadSummary>(EMPTY_SUMMARY)
  const [totalUnread, setTotalUnread] = useState<number>(() => readStoredUnreadCount())

  useEffect(() => {
    function syncFromStorage() {
      setTotalUnread(readStoredUnreadCount())
    }

    function onStorage(event: StorageEvent) {
      if (event.key === CHAT_UNREAD_STORAGE_KEY) {
        syncFromStorage()
      }
    }

    window.addEventListener('storage', onStorage)
    return () => {
      window.removeEventListener('storage', onStorage)
    }
  }, [])

  useEffect(() => {
    if (!user) {
      setSummary(EMPTY_SUMMARY)
      setTotalUnread(0)
      localStorage.setItem(CHAT_UNREAD_STORAGE_KEY, '0')
      return
    }
    const currentUser = user

    let cancelled = false

    async function loadUnread() {
      try {
        const response = await fetch('/api/chat/unread/', {
          headers: buildAuthHeaders(currentUser),
        })
        if (!response.ok || cancelled) {
          return
        }
        const payload = (await response.json()) as ChatUnreadSummary
        if (cancelled) {
          return
        }
        setSummary(payload)
        const nextTotal = Math.max(0, Math.floor(payload.total_unread || 0))
        setTotalUnread(nextTotal)
        localStorage.setItem(CHAT_UNREAD_STORAGE_KEY, String(nextTotal))
      } catch {
        // Ignore temporary poll errors.
      }
    }

    loadUnread().catch(() => {
      // Ignore temporary poll errors.
    })

    const intervalId = window.setInterval(() => {
      loadUnread().catch(() => {
        // Ignore temporary poll errors.
      })
    }, intervalMs)

    return () => {
      cancelled = true
      window.clearInterval(intervalId)
    }
  }, [intervalMs, user])

  return { summary, totalUnread }
}
