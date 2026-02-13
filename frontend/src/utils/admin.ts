export function getAdminIdsFromEnv(): number[] {
  const raw = String(import.meta.env.VITE_ADMIN ?? import.meta.env.ADMIN ?? '').trim()
  if (!raw) {
    return []
  }

  const normalized = raw.replace(/^\[|\]$/g, '')

  return normalized
    .split(',')
    .map((value: string) => Number(value.trim()))
    .filter((value: number) => Number.isFinite(value))
}

export function isAdminUserId(userId: number): boolean {
  return getAdminIdsFromEnv().includes(userId)
}
