export interface ProfileSettingsPayload {
  id: number
  display_name: string
  username: string
  photo: string
  email: string
  telegram_id: number | null
  telegram_username: string
  auth_provider: string
}
