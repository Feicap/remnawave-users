export type ChatScope = 'global' | 'private'

export interface ChatMessageItem {
  id: number
  scope: ChatScope
  sender_id: number
  sender_username: string
  recipient_id: number | null
  recipient_username: string
  body: string
  is_deleted: boolean
  edited_at: string | null
  deleted_at: string | null
  read_by_me: boolean
  delivered_to_recipient: boolean | null
  read_by_recipient: boolean | null
  created_at: string
}

export interface ChatUserItem {
  user_id: number
  username: string
  email: string
  telegram_username: string
  photo: string
  auth_provider: string
  unread_count: number
  last_message_at: string | null
}

export interface ChatUnreadByUser {
  user_id: number
  count: number
}

export interface ChatUnreadSummary {
  global_unread: number
  private_unread_total: number
  private_unread_by_user: ChatUnreadByUser[]
  total_unread: number
}

export interface ChatPagination {
  has_more: boolean
  next_before_id: number | null
  limit: number
}

export interface ChatMessagesResponse {
  scope: ChatScope
  peer_id?: number
  items: ChatMessageItem[]
  pagination: ChatPagination
}

export interface ChatModerationActionItem {
  id: number
  message_id: number
  action: 'edit' | 'delete'
  acted_by_user_id: number
  acted_by_username: string
  is_admin_action: boolean
  previous_body: string
  next_body: string
  created_at: string
}
