export interface ProfileSettingsPayload {
  id: number
  display_name: string
  username: string
  photo: string
  email: string
  telegram_id: number | null
  telegram_username: string
  auth_provider: string
  has_email_auth?: boolean
  has_telegram_auth?: boolean
  can_link_email?: boolean
  can_link_telegram?: boolean
}
