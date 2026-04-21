export interface AdminUserItem {
  id: number
  login: string
  email: string
  date_joined: string | null
  last_login: string | null
  is_online: boolean
  has_password: boolean
  has_remnawave_access: boolean
  subscription_url: string
  re_register_required?: boolean
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
}

export interface AdminUsersResponse {
  items: AdminUserItem[]
  metrics: AdminUsersMetrics
  pagination: AdminUsersPagination
}

export interface ApiError {
  error?: string
}
