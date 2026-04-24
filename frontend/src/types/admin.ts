export interface AdminUserItem {
  id: number
  login: string
  email: string
  display_name: string
  avatar_url: string
  chat_username: string
  chat_email: string
  chat_telegram_username: string
  chat_auth_provider: string
  chat_photo: string
  date_joined: string | null
  last_login: string | null
  is_online: boolean
  has_password: boolean
  has_remnawave_access: boolean
  subscription_url: string
  chat_telegram_id?: number | null
  avatar_scale?: number
  avatar_position_x?: number
  avatar_position_y?: number
  details?: AdminUserDetails
  re_register_required?: boolean
}

export interface AdminUserDetails {
  payment_counts: {
    total: number
    pending: number
    approved: number
    rejected: number
  }
  recent_payment_proofs: {
    id: number
    user_id: number
    username: string
    status: 'pending' | 'approved' | 'rejected'
    created_at: string
    reviewed_at: string | null
    reviewed_by: number | null
    reviewed_by_username: string
    file_url: string
  }[]
  chat_counts: {
    total: number
    sent: number
    received: number
    global: number
    private: number
    deleted: number
    latest_message_at: string | null
  }
  moderation_actions_count: number
  auth_identities: {
    provider: string
    provider_user_id: string
    created_at: string | null
    updated_at: string | null
  }[]
}

export interface AdminUsersMetrics {
  total_users: number
  online_users: number
  online_window_minutes: number
  remnawave_access_users: number
  users_without_password: number
  active_today: number
}

export interface AdminUsersPagination {
  limit: number
  offset: number
  has_more: boolean
  filtered_total?: number
}

export interface AdminUsersResponse {
  items: AdminUserItem[]
  metrics: AdminUsersMetrics
  pagination: AdminUsersPagination
}

export interface ApiError {
  error?: string
}
