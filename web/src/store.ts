// The recording store.
//
// Sitca keeps two things in two places. Everything small and structured lives
// in Supabase: the account, the session, the transcript, the recap, every
// answer the AI ever wrote. Everything heavy lives in Cloudflare R2: the
// recordings themselves, and the frames taken off the screen.
//
// This module is the only part of the app that knows that. It offers the few
// operations the rest of the code needs, asks the server for a link, and then
// talks to R2 straight from the browser, so a recording never passes through
// a server of ours on its way up or down.
//
// Recordings made before the move are still in Supabase. Every read tries R2
// first and falls back, so an old session plays exactly as it always did and
// no one has to migrate anything for it to work.

import type { SupabaseClient } from '@supabase/supabase-js'

export type Where = 'r2' | 'sb'
export interface StoreObject {
  name: string
  size: number
}
export interface Listing {
  where: Where
  objects: StoreObject[]
}
/** A recording ready to play: the whole file if there is one, else the parts. */
export interface Media {
  where: Where | 'none'
  whole: string | null
  /** bytes of the whole file, when the store reports it */
  wholeSize?: number
  parts: string[]
  /** bytes of each part, in the same order, when the store reports them */
  partSizes?: number[]
  /** a playlist of the recording for a phone's own player, when the store has its index */
  hls?: string | null
}

/** A bucket served straight from Cloudflare's edge, when one is set up. */
const PUBLIC_BASE = ((import.meta.env.VITE_R2_PUBLIC_BASE as string) || '').replace(/\/+$/, '')

interface Cached {
  url: string
  until: number
}

export interface Store {
  /** True when this deployment stores recordings in R2. */
  ready(): Promise<boolean>
  upload(key: string, blob: Blob, contentType: string): Promise<{ error?: string }>
  /** Whichever store holds this folder: R2 first, then the older Supabase one. */
  list(prefix: string): Promise<Listing>
  /** One named store only, for clearing a session out of both. */
  listIn(prefix: string, where: Where): Promise<StoreObject[]>
  url(key: string, where: Where): Promise<string | null>
  urls(keys: string[], where: Where): Promise<string[]>
  /** Both candidates, best first, for a reader that does not know where it is. */
  candidates(key: string): Promise<string[]>
  /** Everything needed to play one recording, in a single request. */
  media(owner: string, session: string): Promise<Media>
  download(key: string, where: Where): Promise<ArrayBuffer | null>
  remove(keys: string[], where: Where): Promise<void>
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/**
 * @param sb      the Supabase client, for the fallback and for the token
 * @param session on a recap page, the session being watched: it is what the
 *                server checks the sharing rule against, since the watcher is
 *                usually not signed in at all
 */
export function createStore(sb: SupabaseClient, session?: () => string | null): Store {
  const linkCache = new Map<string, Cached>()
  let readyOnce: Promise<boolean> | null = null

  async function ready(): Promise<boolean> {
    if (!readyOnce) {
      readyOnce = fetch('/api/storage')
        .then((r) => (r.ok ? r.json() : null))
        .then((j) => Boolean(j?.configured && j?.supabase))
        .catch(() => false)
    }
    return readyOnce
  }

  async function token(): Promise<string | null> {
    try {
      const { data } = await sb.auth.getSession()
      return data.session?.access_token ?? null
    } catch {
      return null
    }
  }

  async function post<T>(op: string, body: Record<string, unknown>): Promise<T | null> {
    // Asking for a link is only asking: a request that never arrived, or a
    // server having a bad moment, is asked again rather than reported as a
    // refusal. Three goes, a breath apart; a real "no" comes back at once.
    const waits = [500, 1500]
    for (let attempt = 0; ; attempt++) {
      try {
        const t = await token()
        const r = await fetch('/api/storage', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            ...(t ? { Authorization: `Bearer ${t}` } : {})
          },
          body: JSON.stringify({ op, session: session?.() ?? undefined, ...body })
        })
        // 501 means R2 is not set up and 4xx means not allowed: both are
        // answers. A 5xx is the server failing, and it is asked again.
        if (r.status >= 500) {
          if (attempt < waits.length) {
            await sleep(waits[attempt])
            continue
          }
          throw new Error(`storage ${r.status}`)
        }
        if (!r.ok) return null
        return (await r.json()) as T
      } catch (err) {
        if (err instanceof Error && /^storage \d+$/.test(err.message)) throw err
        // never arrived: the network, not the server's word
        if (attempt < waits.length) {
          await sleep(waits[attempt])
          continue
        }
        return null
      }
    }
  }
  /** One retry after a short pause, for the server's bad moment. */
  async function postRetry<T>(op: string, body: Record<string, unknown>): Promise<T | null> {
    try {
      return await post<T>(op, body)
    } catch {
      await sleep(900)
      return post<T>(op, body)
    }
  }

  // ---------- links ----------

  async function r2Urls(keys: string[]): Promise<string[]> {
    if (keys.length === 0) return []
    // A public bucket needs no permission and no round trip: the link is the
    // key, and Cloudflare's edge has usually cached it already.
    if (PUBLIC_BASE) return keys.map((k) => `${PUBLIC_BASE}/${k.split('/').map(encodeURIComponent).join('/')}`)

    const now = Date.now()
    const out = new Map<string, string>()
    const missing: string[] = []
    for (const k of keys) {
      const hit = linkCache.get(k)
      if (hit && hit.until > now) out.set(k, hit.url)
      else missing.push(k)
    }
    if (missing.length > 0) {
      // asked for in one request, however many parts there are
      for (let i = 0; i < missing.length; i += 200) {
        const slice = missing.slice(i, i + 200)
        const res = await postRetry<{ links: { key: string; url: string }[]; expiresIn: number }>('get', {
          keys: slice
        })
        const until = now + Math.max(60, (res?.expiresIn ?? 3600) - 300) * 1000
        for (const l of res?.links ?? []) {
          linkCache.set(l.key, { url: l.url, until })
          out.set(l.key, l.url)
        }
      }
    }
    return keys.map((k) => out.get(k) ?? '')
  }

  async function sbUrls(keys: string[]): Promise<string[]> {
    if (keys.length === 0) return []
    const { data } = await sb.storage.from('recordings').createSignedUrls(keys, 3600)
    const byPath = new Map((data ?? []).map((s) => [s.path ?? '', s.signedUrl]))
    return keys.map((k) => byPath.get(k) ?? '')
  }

  const urls = async (keys: string[], where: Where): Promise<string[]> =>
    where === 'r2' ? r2Urls(keys) : sbUrls(keys)

  const url = async (key: string, where: Where): Promise<string | null> =>
    (await urls([key], where))[0] || null

  async function candidates(key: string): Promise<string[]> {
    const out: string[] = []
    if (await ready()) {
      const u = (await r2Urls([key]))[0]
      if (u) out.push(u)
    }
    const s = (await sbUrls([key]))[0]
    if (s) out.push(s)
    return out
  }

  // ---------- listing ----------

  async function listIn(prefix: string, where: Where): Promise<StoreObject[]> {
    if (where === 'r2') {
      if (!(await ready())) return []
      const res = await postRetry<{ objects: StoreObject[] }>('list', { prefix })
      return res?.objects ?? []
    }
    const { data } = await sb.storage.from('recordings').list(prefix, {
      limit: 1000,
      sortBy: { column: 'name', order: 'asc' }
    })
    return (data ?? []).map((f) => ({
      name: f.name,
      size: Number((f.metadata as { size?: number } | null)?.size ?? 0)
    }))
  }

  async function list(prefix: string): Promise<Listing> {
    const fresh = await listIn(prefix, 'r2')
    if (fresh.length > 0) return { where: 'r2', objects: fresh }
    return { where: 'sb', objects: await listIn(prefix, 'sb') }
  }

  /**
   * One request, one answer: where the recording is and how to play it.
   * Cloudflare is asked first. A recording made before the move answers
   * 'none' there, and the caller falls back to Supabase as it always did.
   */
  async function media(owner: string, session: string): Promise<Media> {
    // Asked straight out, without first checking whether R2 is set up: this is
    // the one request between opening a recap and the first frame, and a
    // deployment without R2 simply answers that it has none.
    const res = await postRetry<{
      where: Where | 'none'
      whole: string | null
      wholeSize?: number
      parts: { url: string; size?: number }[]
      hls?: string | null
    }>('media', { owner, session })
    if (res && res.where !== 'none') {
      const parts = res.parts ?? []
      const sizes = parts.map((p) => Number(p.size ?? 0))
      return {
        where: 'r2',
        whole: res.whole,
        wholeSize: res.wholeSize,
        parts: parts.map((p) => p.url),
        partSizes: sizes.every((n) => n > 0) ? sizes : undefined,
        hls: res.hls ?? null
      }
    }
    const dir = `${owner}/${session}`
    const objects = await listIn(dir, 'sb')
    const names = objects
      .map((o) => o.name)
      .filter((n) => /^part-\d+\.webm$/.test(n))
      .sort()
    const { data: one } = await sb.storage.from('recordings').createSignedUrl(`${dir}.webm`, 3600)
    const parts = names.length > 0 ? await sbUrls(names.map((n) => `${dir}/${n}`)) : []
    const whole = one?.signedUrl ?? null
    if (!whole && parts.length === 0) return { where: 'none', whole: null, parts: [] }
    const sizes = names.map((n) => objects.find((o) => o.name === n)?.size ?? 0)
    return { where: 'sb', whole, parts: parts.filter(Boolean), partSizes: sizes.every((n) => n > 0) && parts.every(Boolean) ? sizes : undefined }
  }

  // ---------- the operations ----------

  return {
    ready,
    urls,
    url,
    candidates,

    async upload(key, blob, contentType) {
      if (!(await ready())) {
        const { error } = await sb.storage
          .from('recordings')
          .upload(key, blob, { upsert: true, contentType })
        return error ? { error: error.message } : {}
      }
      for (let attempt = 0; attempt < 2; attempt++) {
        const res = await post<{ links: { key: string; url: string }[] }>('put', {
          keys: [{ key, contentType }]
        })
        const link = res?.links?.[0]?.url
        if (!link) {
          if (attempt === 0) {
            await sleep(500)
            continue
          }
          // truthful: we asked and got no link. Which of the two it was —
          // no answer at all, or a refusal — the page cannot tell apart, so
          // it says the thing that is true of both and keeps the piece.
          return { error: navigator.onLine ? 'Storage did not hand out an upload link. It will be tried again.' : 'No connection: the recording waits on this device.' }
        }
        try {
          const r = await fetch(link, {
            method: 'PUT',
            body: blob,
            headers: { 'content-type': contentType }
          })
          if (r.ok) return {}
          if (attempt === 1) return { error: `Storage returned ${r.status}.` }
        } catch (err) {
          if (attempt === 1) return { error: err instanceof Error ? err.message : String(err) }
        }
        await sleep(600)
      }
      return { error: 'Upload failed.' }
    },

    listIn,
    list,
    media,

    async download(key, where) {
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          if (where === 'sb' && attempt === 0) {
            const { data } = await sb.storage.from('recordings').download(key)
            if (data) return await data.arrayBuffer()
          } else {
            const link = (await urls([key], where))[0]
            if (link) {
              const r = await fetch(link, { cache: 'no-store' })
              if (r.ok) return await r.arrayBuffer()
              linkCache.delete(key)
            }
          }
        } catch (err) {
          console.warn('Sitca: part fetch failed, retrying', key, err)
        }
        await sleep(400 * (attempt + 1))
      }
      return null
    },

    async remove(keys, where) {
      if (keys.length === 0) return
      for (const k of keys) linkCache.delete(k)
      if (where === 'r2') await post('del', { keys })
      else await sb.storage.from('recordings').remove(keys)
    }
  }
}
