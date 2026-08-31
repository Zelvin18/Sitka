import { useCallback, useState } from 'react'

function read(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

function write(key: string, value: string): void {
  try {
    localStorage.setItem(key, value)
  } catch {
    /* storage unavailable — sizes just won't persist */
  }
}

export function usePersistedNumber(
  key: string,
  initial: number
): [number, (n: number) => void] {
  const [value, setValue] = useState<number>(() => {
    const raw = read(key)
    const parsed = raw === null ? NaN : Number(raw)
    return Number.isFinite(parsed) ? parsed : initial
  })
  const set = useCallback(
    (n: number) => {
      setValue(n)
      write(key, String(n))
    },
    [key]
  )
  return [value, set]
}

export function usePersistedBool(
  key: string,
  initial: boolean
): [boolean, (b: boolean) => void] {
  const [value, setValue] = useState<boolean>(() => {
    const raw = read(key)
    return raw === null ? initial : raw === '1'
  })
  const set = useCallback(
    (b: boolean) => {
      setValue(b)
      write(key, b ? '1' : '0')
    },
    [key]
  )
  return [value, set]
}

export const clamp = (n: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, n))
