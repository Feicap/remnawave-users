import { useEffect, useRef, useState } from 'react'
import type { AuthUser } from '../types/auth'

const RECONNECT_BASE_DELAY_MS = 1_000
const RECONNECT_MAX_DELAY_MS = 15_000

export interface ChatRealtimeEvent {
  event: string
  scope: 'global' | 'private' | string
  message_id?: number
  sender_id?: number
  recipient_id?: number | null
  user_id?: number
  peer_id?: number
  at?: string
}

interface ChatRealtimeEnvelope {
  type: string
  event?: ChatRealtimeEvent
  ts?: string
}

function buildChatWsUrl(user: AuthUser): string {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
  const url = new URL('/ws/chat/', window.location.origin)
  url.protocol = protocol
  url.searchParams.set('user_id', String(user.id))
  if (user.email) {
    url.searchParams.set('email', user.email)
  }
  if (typeof user.telegram_id === 'number') {
    url.searchParams.set('telegram_id', String(user.telegram_id))
  }
  return url.toString()
}

function reconnectDelay(attempt: number): number {
  const exponential = RECONNECT_BASE_DELAY_MS * 2 ** Math.min(attempt, 6)
  return Math.min(RECONNECT_MAX_DELAY_MS, exponential)
}

export function useChatRealtime(
  user: AuthUser | null,
  enabled: boolean,
  onEvent: (event: ChatRealtimeEvent) => void,
): { isConnected: boolean } {
  const [isConnected, setIsConnected] = useState(false)
  const onEventRef = useRef(onEvent)

  useEffect(() => {
    onEventRef.current = onEvent
  }, [onEvent])

  useEffect(() => {
    if (!enabled || !user) {
      setIsConnected(false)
      return
    }

    let socket: WebSocket | null = null
    let reconnectTimer: number | null = null
    let reconnectAttempt = 0
    let isUnmounted = false

    const connect = () => {
      if (isUnmounted) {
        return
      }

      socket = new WebSocket(buildChatWsUrl(user))

      socket.onopen = () => {
        reconnectAttempt = 0
        setIsConnected(true)
      }

      socket.onmessage = (messageEvent) => {
        let payload: ChatRealtimeEnvelope | null = null
        try {
          payload = JSON.parse(messageEvent.data) as ChatRealtimeEnvelope
        } catch {
          return
        }
        if (!payload) {
          return
        }
        if (payload.type === 'ping') {
          socket?.send(JSON.stringify({ type: 'ping', ts: payload.ts ?? null }))
          return
        }
        if (payload.type === 'chat_event' && payload.event) {
          onEventRef.current(payload.event)
        }
      }

      socket.onerror = () => {
        socket?.close()
      }

      socket.onclose = () => {
        setIsConnected(false)
        if (isUnmounted) {
          return
        }
        const delay = reconnectDelay(reconnectAttempt)
        reconnectAttempt += 1
        reconnectTimer = window.setTimeout(() => {
          reconnectTimer = null
          connect()
        }, delay)
      }
    }

    connect()

    return () => {
      isUnmounted = true
      setIsConnected(false)
      if (reconnectTimer !== null) {
        window.clearTimeout(reconnectTimer)
      }
      socket?.close()
    }
  }, [enabled, user])

  return { isConnected }
}
