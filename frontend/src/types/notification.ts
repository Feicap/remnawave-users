export interface UserNotification {
  id: number
  kind: 'payment' | 'chat' | 'account' | 'system' | string
  title: string
  body: string
  link_url: string
  is_read: boolean
  created_at: string
  read_at: string | null
}

export interface NotificationsResponse {
  items: UserNotification[]
  unread_count: number
}
