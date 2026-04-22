export interface AuthUser {
  id: number
  display_name?: string
  username?: string
  photo?: string
  token?: string
  subscription_url?: string
  email?: string
  telegram_id?: number
  telegram_username?: string
  auth_provider?: 'email' | 'telegram'
  has_email_auth?: boolean
  has_telegram_auth?: boolean
  can_link_email?: boolean
  can_link_telegram?: boolean
}
