import type { CSSProperties } from 'react'

export interface AvatarPresentation {
  avatar_scale?: number
  avatar_position_x?: number
  avatar_position_y?: number
}

const MIN_AVATAR_SCALE = 1
const MAX_AVATAR_SCALE = 3
const MIN_AVATAR_POSITION = 0
const MAX_AVATAR_POSITION = 100

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}

export function normalizeAvatarPresentation(meta?: AvatarPresentation): Required<AvatarPresentation> {
  const scale = typeof meta?.avatar_scale === 'number' ? meta.avatar_scale : 1
  const positionX = typeof meta?.avatar_position_x === 'number' ? meta.avatar_position_x : 50
  const positionY = typeof meta?.avatar_position_y === 'number' ? meta.avatar_position_y : 50

  return {
    avatar_scale: clamp(scale, MIN_AVATAR_SCALE, MAX_AVATAR_SCALE),
    avatar_position_x: clamp(positionX, MIN_AVATAR_POSITION, MAX_AVATAR_POSITION),
    avatar_position_y: clamp(positionY, MIN_AVATAR_POSITION, MAX_AVATAR_POSITION),
  }
}

export function getAvatarImageStyle(meta?: AvatarPresentation): CSSProperties {
  const normalized = normalizeAvatarPresentation(meta)
  return {
    objectPosition: `${normalized.avatar_position_x}% ${normalized.avatar_position_y}%`,
    transform: `scale(${normalized.avatar_scale})`,
    transformOrigin: 'center center',
  }
}

