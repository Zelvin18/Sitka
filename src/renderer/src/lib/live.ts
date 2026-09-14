import { useEffect, useState } from 'react'

/**
 * One live session at a time, across every tab of the account.
 *
 * The tab that is recording writes a heartbeat; every tab reads it. A
 * heartbeat younger than STALE_MS means a session is live somewhere, so the
 * rest of the app can say so and refuse to start a second one. The desktop
 * app has one window, so there it simply mirrors its own recording state.
 */

export interface LiveBeat {
  sessionId: string
  title: string
  startedAt: number
  tab: string
  beat: number
}

const KEY = 'sitka.live'
const TAB_KEY = 'sitka.tab'
const STALE_MS = 15000

function tabId(): string {
  try {
    let id = sessionStorage.getItem(TAB_KEY)
    if (!id) {
      id = Math.random().toString(36).slice(2)
      sessionStorage.setItem(TAB_KEY, id)
    }
    return id
  } catch {
    return 'tab'
  }
}

export function readLive(): LiveBeat | null {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return null
    const b = JSON.parse(raw) as LiveBeat
    if (!b || !b.sessionId || Date.now() - b.beat > STALE_MS) return null
    return b
  } catch {
    return null
  }
}

/** Written by the recording tab every few seconds. */
export function writeLiveBeat(sessionId: string, title: string, startedAt: number): void {
  try {
    const b: LiveBeat = { sessionId, title, startedAt, tab: tabId(), beat: Date.now() }
    localStorage.setItem(KEY, JSON.stringify(b))
  } catch {
    /* private mode */
  }
}

export function clearLiveBeat(sessionId: string): void {
  try {
    const cur = readLive()
    if (!cur || cur.sessionId === sessionId) localStorage.removeItem(KEY)
  } catch {
    /* ignore */
  }
}

export function isThisTab(b: LiveBeat | null): boolean {
  return Boolean(b && b.tab === tabId())
}

/** The live session, if any, in this tab or another. Updates within a second of a change. */
export function useLive(): LiveBeat | null {
  const [live, setLive] = useState<LiveBeat | null>(() => readLive())
  useEffect(() => {
    const check = (): void => setLive(readLive())
    const onStorage = (e: StorageEvent): void => {
      if (e.key === KEY || e.key === null) check()
    }
    window.addEventListener('storage', onStorage)
    const t = window.setInterval(check, 2000)
    return () => {
      window.removeEventListener('storage', onStorage)
      clearInterval(t)
    }
  }, [])
  return live
}
