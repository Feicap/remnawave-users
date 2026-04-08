export interface AuthUser {
  id: number
  username?: string
  photo?: string
  token?: string
  subscription_url?: string
  email?: string
  telegram_id?: number
  telegram_username?: string
  auth_provider?: 'email' | 'telegram'
}
