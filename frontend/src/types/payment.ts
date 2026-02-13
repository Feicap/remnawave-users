export type PaymentStatus = 'pending' | 'approved' | 'rejected'

export interface PaymentProof {
  id: number
  user_id: number
  username: string
  status: PaymentStatus
  created_at: string
  reviewed_at: string | null
  reviewed_by: number | null
  reviewed_by_username: string
  file_url: string
}

export interface PaymentProofUser {
  user_id: number
  username: string
  pending_count: number
}
