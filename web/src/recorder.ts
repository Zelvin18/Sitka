/**
 * The recording engine: every piece a recorder makes reaches the cloud, or
 * stays on this device until it does, and the page is told the truth about
 * which.
 *
 * What it promises:
 *
 *  - A piece is kept on the device (IndexedDB) the moment it is made, and a
 *    piece of the recording (a "part", about 3 MB) is recorded as soon as it
 *    is formed, so a tab that dies leaves nothing ambiguous behind.
 *  - Part numbers come from a counter kept on the device, never from a
 *    listing of the cloud. The cloud never has a part written over: a number
 *    already taken there by something else is replaced by a new one.
 *  - A device copy is deleted only after the cloud confirms the part. A read
 *    of the device that fails is a failure, never "nothing there".
 *  - A part that fails to go up is tried again, with growing pauses, during
 *    the recording as well as after it; parts that could not be kept on the
 *    device are held in memory and tried the same way. Memory is let go of a
 *    part the moment the device has confirmed its copy.
 *  - "In the cloud up to" is the end of the last part with no gap before it.
 *  - The recording's first bytes (its header, which every player needs) are
 *    kept on their own and sent beside the parts as init.bin.
 *  - Every upload has a time limit; ending a recording waits a bounded time.
 *  - One tab records a session and holds a lock on it (Web Locks); another
 *    tab never recovers or uploads a session that is live elsewhere.
 *  - A deleted session is marked first: no piece of it goes up afterwards.
 *
 * The page gives it an uploader (how a part reaches the cloud) and listens to
 * what it says; it knows nothing about Supabase, R2 or the page itself, which
 * is what lets tests drill it (tests/suites/recorder.test.mjs).
 */

/**
 * `taken`: the cloud already holds that number (with its size). `deleted`:
 * the server says the session was deleted (on another tab or device): the
 * engine stops sending it and clears its device copy, as a delete here would.
 */
/** how long the recorder takes to hand over its first piece (the page asks for one every 3 s) */
const FIRST_PIECE_MS = 3000

export type PutResult = { ok: true } | { error: string; taken?: { size: number }; deleted?: boolean }

export interface Uploader {
  /** Send one part. `taken`: the cloud already holds that number (with its size). */
  put(sessionId: string, partNo: number, blob: Blob, kind: string, signal: AbortSignal): Promise<PutResult>
  /** Send the recording's header, kept beside the parts. */
  putHeader(sessionId: string, blob: Blob, kind: string, signal: AbortSignal): Promise<PutResult>
  /** The part numbers the cloud holds for a session; null when that cannot be learned. */
  cloudParts(sessionId: string): Promise<number[] | null>
}

export interface EngineEvents {
  /** a part is in the cloud; upToPart/upToMs: how far the recording is up with no gap */
  uploaded?(d: { sessionId: string; partNo: number; upToPart: number; upToMs: number | null }): void
  /** a part could not go up (it will be tried again) */
  trouble?(d: { sessionId: string; error: string }): void
  /** whether this device can keep a safety copy of the recording */
  deviceCopy?(d: { sessionId: string; ok: boolean; why?: string }): void
  /** something worth an operator's attention */
  report?(message: string): void
}

export interface EngineOptions {
  uploader: Uploader
  events?: EngineEvents
  /** bytes per part (default 3 MB) */
  partBytes?: number
  now?: () => number
  /** pauses between tries of one part, in ms; the last repeats */
  backoff?: number[]
  /** uploads at once */
  concurrency?: number
  /** time allowed for one upload of this many bytes */
  timeoutFor?: (bytes: number) => number
}

interface ChunkRec {
  sessionId: string
  seq: number
  at: number
  buf: ArrayBuffer
}
export interface PartRec {
  sessionId: string
  partNo: number
  fromSeq: number
  toSeq: number
  /** when its last chunk was made (for "in the cloud up to") */
  lastAt?: number
}
interface SessionRec {
  sessionId: string
  nextPart: number
  nextSeq: number
  startedAt: number
  kind?: string
  lastAt?: number
  /** parts confirmed in the cloud, with when each ended */
  done: [number, number][]
  headerUp?: boolean
  ended?: boolean
  /** set when the session is deleted: nothing of it goes up again */
  tombstone?: number
}

type Read<T> = { ok: true; value: T } | { ok: false }

// ---------- the device ----------

const REC_DB = 'sitka-recordings' // chunks and parts (the layout the older recorder used, kept as it was)
const META_DB = 'sitka-recorder' // the engine's own records: counters, headers, text backups
/** every store this device keeps, for clearing it when an account is deleted */
export const DEVICE_DATABASES = [REC_DB, META_DB]

function openDb(name: string, version: number, upgrade: (db: IDBDatabase) => void): Promise<IDBDatabase | null> {
  return new Promise((resolve) => {
    try {
      const req = indexedDB.open(name, version)
      req.onupgradeneeded = () => upgrade(req.result)
      req.onsuccess = () => {
        const db = req.result
        // another tab upgrading the store: this one steps aside, and opens again when next asked
        db.onversionchange = () => db.close()
        resolve(db)
      }
      req.onerror = () => resolve(null)
      req.onblocked = () => resolve(null)
    } catch {
      resolve(null)
    }
  })
}

/** A database that is opened again after a failure, instead of failing for good. */
class Db {
  private db: IDBDatabase | null = null
  private opening: Promise<IDBDatabase | null> | null = null
  private failedAt = 0
  constructor(
    private name: string,
    private version: number,
    private upgrade: (db: IDBDatabase) => void
  ) {}
  async get(): Promise<IDBDatabase | null> {
    if (this.db) return this.db
    if (this.opening) return this.opening
    // a failed open is tried again, a moment later, rather than never
    if (this.failedAt && Date.now() - this.failedAt < 3000) return null
    this.opening = openDb(this.name, this.version, this.upgrade).then((db) => {
      this.opening = null
      if (db) {
        this.db = db
        db.onclose = () => (this.db = null)
      } else this.failedAt = Date.now()
      return db
    })
    return this.opening
  }
  /** One request in its own transaction; ok:false when the device refused or failed it. */
  async run<T>(store: string, mode: IDBTransactionMode, make: (s: IDBObjectStore) => IDBRequest<T> | void): Promise<Read<T | undefined>> {
    const db = await this.get()
    if (!db) return { ok: false }
    return new Promise((resolve) => {
      try {
        const tx = db.transaction(store, mode)
        const req = make(tx.objectStore(store))
        let out: T | undefined
        if (req) req.onsuccess = () => (out = req.result)
        tx.oncomplete = () => resolve({ ok: true, value: out })
        tx.onerror = () => resolve({ ok: false })
        tx.onabort = () => resolve({ ok: false })
      } catch {
        // a connection closed under us: opened again next time
        this.db = null
        resolve({ ok: false })
      }
    })
  }
}

const recDb = new Db(REC_DB, 1, (db) => {
  if (!db.objectStoreNames.contains('chunks')) db.createObjectStore('chunks', { keyPath: ['sessionId', 'seq'] }).createIndex('bySession', 'sessionId')
  if (!db.objectStoreNames.contains('parts')) db.createObjectStore('parts', { keyPath: ['sessionId', 'partNo'] }).createIndex('bySession', 'sessionId')
})
const metaDb = new Db(META_DB, 1, (db) => {
  if (!db.objectStoreNames.contains('sessions')) db.createObjectStore('sessions', { keyPath: 'sessionId' })
  if (!db.objectStoreNames.contains('headers')) db.createObjectStore('headers', { keyPath: 'sessionId' })
  if (!db.objectStoreNames.contains('backups')) db.createObjectStore('backups', { keyPath: 'id' })
})

const MAX = Number.MAX_SAFE_INTEGER
const range = (sessionId: string, from = 0, to = MAX): IDBKeyRange => IDBKeyRange.bound([sessionId, from], [sessionId, to])

export const device = {
  putChunk: async (c: ChunkRec): Promise<boolean> => (await recDb.run('chunks', 'readwrite', (s) => s.put(c))).ok,
  /** the chunks of one part, by key range: never the whole session's backlog */
  chunksIn: async (sessionId: string, from: number, to: number): Promise<Read<ChunkRec[]>> => {
    const r = await recDb.run<ChunkRec[]>('chunks', 'readonly', (s) => s.getAll(range(sessionId, from, to)))
    return r.ok ? { ok: true, value: (r.value ?? []).sort((a, b) => a.seq - b.seq) } : r
  },
  /** every chunk key on the device, without reading a single recording byte */
  chunkKeys: async (): Promise<Read<[string, number][]>> => {
    const r = await recDb.run<IDBValidKey[]>('chunks', 'readonly', (s) => s.getAllKeys())
    return r.ok ? { ok: true, value: (r.value ?? []) as unknown as [string, number][] } : r
  },
  chunkKeysOf: async (sessionId: string): Promise<Read<number[]>> => {
    const r = await recDb.run<IDBValidKey[]>('chunks', 'readonly', (s) => s.getAllKeys(range(sessionId)))
    return r.ok ? { ok: true, value: ((r.value ?? []) as unknown as [string, number][]).map((k) => k[1]) } : r
  },
  /** the last chunk of a session (one read, for when it was made) */
  lastChunk: async (sessionId: string): Promise<Read<ChunkRec | null>> => {
    const db = await recDb.get()
    if (!db) return { ok: false }
    return new Promise((resolve) => {
      try {
        const tx = db.transaction('chunks', 'readonly')
        const req = tx.objectStore('chunks').openCursor(range(sessionId), 'prev')
        let out: ChunkRec | null = null
        req.onsuccess = () => {
          out = (req.result?.value as ChunkRec | undefined) ?? null
        }
        tx.oncomplete = () => resolve({ ok: true, value: out })
        tx.onerror = () => resolve({ ok: false })
        tx.onabort = () => resolve({ ok: false })
      } catch {
        resolve({ ok: false })
      }
    })
  },
  deleteChunks: async (sessionId: string, from = 0, to = MAX): Promise<boolean> =>
    (await recDb.run('chunks', 'readwrite', (s) => s.delete(range(sessionId, from, to)))).ok,
  putPart: async (p: PartRec): Promise<boolean> => (await recDb.run('parts', 'readwrite', (s) => s.put(p))).ok,
  deletePart: async (sessionId: string, partNo: number): Promise<boolean> =>
    (await recDb.run('parts', 'readwrite', (s) => s.delete([sessionId, partNo]))).ok,
  deleteParts: async (sessionId: string): Promise<boolean> => (await recDb.run('parts', 'readwrite', (s) => s.delete(range(sessionId)))).ok,
  partsOf: async (sessionId: string): Promise<Read<PartRec[]>> => {
    const r = await recDb.run<PartRec[]>('parts', 'readonly', (s) => s.getAll(range(sessionId)))
    return r.ok ? { ok: true, value: (r.value ?? []).sort((a, b) => a.partNo - b.partNo) } : r
  },
  allParts: async (): Promise<Read<PartRec[]>> => {
    const r = await recDb.run<PartRec[]>('parts', 'readonly', (s) => s.getAll())
    return r.ok ? { ok: true, value: r.value ?? [] } : r
  },
  getSession: async (sessionId: string): Promise<Read<SessionRec | null>> => {
    const r = await metaDb.run<SessionRec>('sessions', 'readonly', (s) => s.get(sessionId))
    return r.ok ? { ok: true, value: r.value ?? null } : r
  },
  putSession: async (rec: SessionRec): Promise<boolean> => (await metaDb.run('sessions', 'readwrite', (s) => s.put(rec))).ok,
  putHeader: async (sessionId: string, buf: ArrayBuffer, kind: string): Promise<boolean> =>
    (await metaDb.run('headers', 'readwrite', (s) => s.put({ sessionId, buf, kind }))).ok,
  getHeader: async (sessionId: string): Promise<Read<{ buf: ArrayBuffer; kind: string } | null>> => {
    const r = await metaDb.run<{ buf: ArrayBuffer; kind: string }>('headers', 'readonly', (s) => s.get(sessionId))
    return r.ok ? { ok: true, value: r.value ?? null } : r
  },
  deleteHeader: async (sessionId: string): Promise<boolean> => (await metaDb.run('headers', 'readwrite', (s) => s.delete(sessionId))).ok,
  // text backups of a session, when the database could not be written (kept here, not in localStorage's 5 MB)
  putBackup: async (row: { id: string }): Promise<boolean> => (await metaDb.run('backups', 'readwrite', (s) => s.put(row))).ok,
  getBackups: async <T>(): Promise<T[]> => {
    const r = await metaDb.run<T[]>('backups', 'readonly', (s) => s.getAll())
    return r.ok ? (r.value ?? []) : []
  },
  deleteBackup: async (id: string): Promise<boolean> => (await metaDb.run('backups', 'readwrite', (s) => s.delete(id))).ok
}

// ---------- what the recording is ----------

/** 'video/mp4' or 'video/webm' from a file's first bytes (anything else: octet-stream). */
export function sniff(bytes: Uint8Array): string {
  if (bytes.length >= 8 && bytes[4] === 0x66 && bytes[5] === 0x74 && bytes[6] === 0x79 && bytes[7] === 0x70) return 'video/mp4'
  if (bytes.length >= 4 && bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3) return 'video/webm'
  return 'application/octet-stream'
}

// ---------- locks: one tab per recording ----------

type Locks = {
  request(name: string, opts: { ifAvailable?: boolean }, fn: (lock: unknown) => Promise<unknown>): Promise<unknown>
}
const locks = (): Locks | null => {
  const l = (globalThis.navigator as unknown as { locks?: Locks } | undefined)?.locks
  return l && typeof l.request === 'function' ? l : null
}
const lockName = (sessionId: string): string => `sitka-recording-${sessionId}`

// ---------- the engine ----------

interface Live {
  rec: SessionRec
  pending: { seq: number; buf: ArrayBuffer; at: number; write: Promise<boolean> }[]
  bytes: number
  release?: () => void
  forming: Promise<void>
  warned: boolean
}
interface Job {
  sessionId: string
  partNo: number
  attempt: number
  due: number
}

export class RecordingEngine {
  private up: Uploader
  private ev: EngineEvents
  private partBytes: number
  private now: () => number
  private backoff: number[]
  private concurrency: number
  private timeoutFor: (bytes: number) => number
  private live = new Map<string, Live>()
  private recs = new Map<string, SessionRec>()
  /** parts whose device copy is incomplete: their bytes (and record) held here until the cloud has them */
  private mem = new Map<string, { part: PartRec; bufs: ArrayBuffer[] }>()
  private queue = new Map<string, Job>()
  private running = new Set<string>()
  /** uploads on their way, by session, so a delete can stop them */
  private inFlight = new Map<string, Set<AbortController>>()
  private timer: ReturnType<typeof setTimeout> | null = null
  private idle: (() => void)[] = []

  constructor(o: EngineOptions) {
    this.up = o.uploader
    this.ev = o.events ?? {}
    this.partBytes = o.partBytes ?? 3 * 1024 * 1024
    this.now = o.now ?? (() => Date.now())
    this.backoff = o.backoff ?? [2000, 5000, 15000, 30000, 60000, 120000]
    this.concurrency = o.concurrency ?? 2
    // a minute, plus twenty seconds a megabyte: long for a slow line, short for a dead one
    this.timeoutFor = o.timeoutFor ?? ((bytes) => 60000 + (bytes / 1048576) * 20000)
  }

  private key = (sessionId: string, partNo: number): string => `${sessionId}:${partNo}`
  private say = (m: string): void => this.ev.report?.(m)

  // ---- the session's own record: counters, done parts, tombstone ----

  private async rec(sessionId: string): Promise<SessionRec | null> {
    const held = this.recs.get(sessionId)
    if (held) return held
    const r = await device.getSession(sessionId)
    if (r.ok && r.value) {
      this.recs.set(sessionId, r.value)
      return r.value
    }
    return null
  }
  private async save(rec: SessionRec): Promise<void> {
    this.recs.set(rec.sessionId, rec)
    await device.putSession(rec)
  }
  /**
   * A session this device has pieces of but no record for (recorded before
   * the engine, or its record lost): the counters are taken past everything
   * the device and the cloud hold, so no number is ever used twice.
   */
  private async adopt(sessionId: string): Promise<SessionRec> {
    const had = await this.rec(sessionId)
    if (had) return had
    let nextSeq = 0
    let nextPart = 0
    const keys = await device.chunkKeysOf(sessionId)
    if (keys.ok && keys.value.length) nextSeq = Math.max(...keys.value) + 1
    const parts = await device.partsOf(sessionId)
    if (parts.ok) for (const p of parts.value) {
      nextPart = Math.max(nextPart, p.partNo + 1)
      nextSeq = Math.max(nextSeq, p.toSeq + 1)
    }
    const cloud = await this.up.cloudParts(sessionId).catch(() => null)
    if (cloud) for (const n of cloud) nextPart = Math.max(nextPart, n + 1)
    const rec: SessionRec = { sessionId, nextPart, nextSeq, startedAt: this.now(), done: [], ended: true }
    await this.save(rec)
    return rec
  }

  /** How far the recording is in the cloud with no gap: the last such part, and when it ended. */
  watermark(rec: SessionRec): { upToPart: number; upToMs: number | null } {
    const ends = new Map(rec.done)
    let n = -1
    while (ends.has(n + 1)) n++
    const at = n >= 0 ? ends.get(n) ?? null : null
    return { upToPart: n, upToMs: at !== null && at > 0 ? Math.max(0, at - rec.startedAt) : null }
  }

  // ---- recording ----

  /** A recording starts here, before any network: its pieces are safe from the first one. */
  async begin(sessionId: string, startedAt = this.now()): Promise<void> {
    const had = await this.rec(sessionId)
    const rec: SessionRec = had && !had.tombstone ? { ...had, ended: false } : { sessionId, nextPart: 0, nextSeq: 0, startedAt, done: [] }
    const live: Live = { rec, pending: [], bytes: 0, forming: Promise.resolve(), warned: false }
    this.live.set(sessionId, live)
    await this.save(rec)
    // one tab records a session: the lock is held until the recording ends
    const l = locks()
    if (l) {
      void l
        .request(lockName(sessionId), {}, () => new Promise<void>((release) => (live.release = release)))
        .catch(() => undefined)
    }
    void this.checkDevice(sessionId)
  }

  /** Can this device keep the recording's safety copy? Said once, and kept as its own state. */
  private async checkDevice(sessionId: string): Promise<void> {
    try {
      const st = (globalThis.navigator as unknown as { storage?: StorageManager } | undefined)?.storage
      if (!st) return
      let persisted = st.persisted ? await st.persisted() : true
      if (!persisted && st.persist) persisted = await st.persist()
      const est = st.estimate ? await st.estimate() : null
      const free = est && est.quota !== undefined ? est.quota - (est.usage ?? 0) : null
      if (free !== null && free < 400 * 1024 * 1024) {
        this.ev.deviceCopy?.({ sessionId, ok: false, why: 'This device is nearly out of space for the safety copy. Keep this tab open until the recording is in the cloud.' })
      } else if (!persisted) {
        // the browser may clear it under pressure: not a fault, but not promised either
        this.ev.deviceCopy?.({ sessionId, ok: true, why: 'The browser did not promise to keep the safety copy; the cloud copy is what counts.' })
      } else this.ev.deviceCopy?.({ sessionId, ok: true })
    } catch {
      /* an older browser: nothing to say */
    }
  }

  /**
   * One piece from the recorder. Kept on the device first; formed into a part
   * when enough has gathered. A piece for a session not recording here (the
   * recorder's last piece arriving after the end) becomes a part of its own,
   * numbered after every other.
   */
  async add(sessionId: string, buf: ArrayBuffer): Promise<{ late: boolean; partNo?: number }> {
    const live = this.live.get(sessionId)
    if (!live) return this.late(sessionId, buf)
    const rec = live.rec
    const seq = rec.nextSeq++
    const at = this.now()
    rec.lastAt = at
    if (seq === 0) {
      rec.kind = sniff(new Uint8Array(buf.slice(0, 12)))
      void this.keepHeader(sessionId, buf, rec.kind)
      // The recording began about one piece before its first piece arrived,
      // not when the session was made: the screen picker and the permission
      // prompts come between, and "in the cloud up to" once ran ahead by them.
      rec.startedAt = Math.max(rec.startedAt, at - FIRST_PIECE_MS)
    }
    const write = device.putChunk({ sessionId, seq, at, buf })
    live.pending.push({ seq, buf, at, write })
    live.bytes += buf.byteLength
    void this.save(rec)
    const kept = await write
    if (!kept && !live.warned) {
      live.warned = true
      this.ev.deviceCopy?.({ sessionId, ok: false, why: 'This device could not keep a safety copy, so keep this tab open until the recording is in the cloud.' })
      this.say(`device copy not kept for ${sessionId} (IndexedDB write failed)`)
    }
    if (live.bytes >= this.partBytes) await this.form(sessionId)
    return { late: false }
  }

  /** The header: every player needs it, and the first part alone carried it. */
  private async keepHeader(sessionId: string, buf: ArrayBuffer, kind: string): Promise<void> {
    const copy = buf.slice(0)
    await device.putHeader(sessionId, copy, kind)
    this.enqueue(sessionId, -1)
  }

  /** The gathered pieces become the next part: numbered from the counter, recorded at once. */
  private form(sessionId: string): Promise<void> {
    const live = this.live.get(sessionId)
    if (!live || live.pending.length === 0) return live?.forming ?? Promise.resolve()
    const chunks = live.pending
    live.pending = []
    live.bytes = 0
    const partNo = live.rec.nextPart++
    const part: PartRec = { sessionId, partNo, fromSeq: chunks[0].seq, toSeq: chunks[chunks.length - 1].seq, lastAt: chunks[chunks.length - 1].at }
    void this.save(live.rec)
    live.forming = live.forming.then(async () => {
      const kept = await Promise.all(chunks.map((c) => c.write))
      const recorded = await device.putPart(part)
      // memory holds only what the device could not: the rest is let go now
      if (!recorded || kept.some((k) => !k)) this.mem.set(this.key(sessionId, partNo), { part, bufs: chunks.map((c) => c.buf) })
      this.enqueue(sessionId, partNo)
    })
    return live.forming
  }

  private async late(sessionId: string, buf: ArrayBuffer): Promise<{ late: true; partNo?: number }> {
    const rec = await this.adopt(sessionId)
    if (rec.tombstone) return { late: true }
    const seq = rec.nextSeq++
    const partNo = rec.nextPart++
    const at = this.now()
    await this.save(rec)
    const kept = await device.putChunk({ sessionId, seq, at, buf })
    const part: PartRec = { sessionId, partNo, fromSeq: seq, toSeq: seq, lastAt: at }
    const recorded = await device.putPart(part)
    if (!kept || !recorded) this.mem.set(this.key(sessionId, partNo), { part, bufs: [buf] })
    this.say(`late recording piece kept (${sessionId}, ${Math.round(buf.byteLength / 1024)} KB as part ${partNo})`)
    this.enqueue(sessionId, partNo)
    return { late: true, partNo }
  }

  /**
   * The recording is over: its tail becomes the last part, and the engine
   * waits (at most `waitMs`) for everything to go up. Returns how many parts
   * are still only on this device (they keep being tried).
   */
  async end(sessionId: string, waitMs = 30000): Promise<{ left: number }> {
    const live = this.live.get(sessionId)
    if (live) {
      await this.form(sessionId)
      await live.forming
      live.rec.ended = true
      await this.save(live.rec)
      this.live.delete(sessionId)
      live.release?.()
    }
    await this.drained(sessionId, waitMs)
    return { left: await this.pending(sessionId) }
  }

  /** Parts of this session not yet in the cloud (on the device or held in memory). */
  async pending(sessionId: string): Promise<number> {
    const parts = await device.partsOf(sessionId)
    const nos = new Set<number>(parts.ok ? parts.value.map((p) => p.partNo) : [])
    for (const [k, m] of this.mem) if (k.startsWith(sessionId + ':')) nos.add(m.part.partNo)
    const live = this.live.get(sessionId)
    return nos.size + (live && live.pending.length > 0 ? 1 : 0)
  }

  /** Is anything still in hand (a recording, a queue, an upload)? */
  busy(): boolean {
    return this.live.size > 0 || this.queue.size > 0 || this.running.size > 0 || this.mem.size > 0
  }
  isLive(sessionId: string): boolean {
    return this.live.has(sessionId)
  }

  // ---- uploading ----

  private enqueue(sessionId: string, partNo: number, delay = 0): void {
    const k = this.key(sessionId, partNo)
    if (this.running.has(k)) return
    const had = this.queue.get(k)
    const due = this.now() + delay
    if (had && had.due <= due) return
    this.queue.set(k, { sessionId, partNo, attempt: had?.attempt ?? 0, due })
    this.pump()
  }

  private pump(): void {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    const now = this.now()
    const ready = [...this.queue.values()].filter((j) => j.due <= now).sort((a, b) => a.partNo - b.partNo)
    for (const job of ready) {
      if (this.running.size >= this.concurrency) break
      const k = this.key(job.sessionId, job.partNo)
      if (this.running.has(k)) continue
      this.queue.delete(k)
      this.running.add(k)
      void this.send(job)
        .catch((err) => {
          this.say(`upload of ${k} broke: ${err instanceof Error ? err.message : String(err)}`)
          this.retryLater(job, 'the upload broke off')
        })
        .finally(() => {
          this.running.delete(k)
          this.pump()
        })
    }
    if (this.queue.size > 0) {
      const next = Math.min(...[...this.queue.values()].map((j) => j.due))
      this.timer = setTimeout(() => this.pump(), Math.max(50, next - this.now()))
      // a waiting retry never keeps a process alive on its own (tests, workers)
      ;(this.timer as unknown as { unref?: () => void }).unref?.()
    }
    if (this.queue.size === 0 && this.running.size === 0) {
      const waiting = this.idle
      this.idle = []
      waiting.forEach((f) => f())
    }
  }

  private retryLater(job: Job, error: string): void {
    const wait = this.backoff[Math.min(job.attempt, this.backoff.length - 1)]
    const k = this.key(job.sessionId, job.partNo)
    this.queue.set(k, { ...job, attempt: job.attempt + 1, due: this.now() + wait })
    this.ev.trouble?.({ sessionId: job.sessionId, error })
  }

  private async send(job: Job): Promise<void> {
    const { sessionId, partNo } = job
    const rec = await this.rec(sessionId)
    if (rec?.tombstone) return
    // A time limit per upload, and a way for a delete to stop it. Made by
    // hand: AbortSignal.timeout is missing on iPhones before iOS 16, where it
    // made every upload fail.
    const made: { c: AbortController; t: ReturnType<typeof setTimeout> }[] = []
    const signalFor = (bytes: number): AbortSignal => {
      const c = new AbortController()
      const t = setTimeout(() => c.abort(), this.timeoutFor(bytes))
      ;(t as unknown as { unref?: () => void }).unref?.()
      made.push({ c, t })
      const set = this.inFlight.get(sessionId) ?? new Set<AbortController>()
      set.add(c)
      this.inFlight.set(sessionId, set)
      return c.signal
    }
    try {
      await this.sendWith(job, rec, signalFor)
    } finally {
      const set = this.inFlight.get(sessionId)
      for (const { c, t } of made) {
        clearTimeout(t)
        set?.delete(c)
      }
      if (set && set.size === 0) this.inFlight.delete(sessionId)
    }
  }

  private async sendWith(job: Job, rec: SessionRec | null, signalFor: (bytes: number) => AbortSignal): Promise<void> {
    const { sessionId, partNo } = job

    // the header, sent once beside the parts
    if (partNo === -1) {
      if (rec?.headerUp) return
      const h = await device.getHeader(sessionId)
      if (!h.ok) return this.retryLater(job, 'the device could not be read')
      if (!h.value) return
      const r = await this.up.putHeader(sessionId, new Blob([h.value.buf], { type: h.value.kind }), h.value.kind, signalFor(h.value.buf.byteLength))
      if ('error' in r && r.deleted) return this.forget(sessionId)
      if ('error' in r && !r.taken) return this.retryLater(job, r.error)
      if (rec) {
        rec.headerUp = true
        await this.save(rec)
      }
      return
    }

    const held = this.mem.get(this.key(sessionId, partNo))
    let part = held?.part ?? null
    if (!part) {
      const parts = await device.partsOf(sessionId)
      if (!parts.ok) return this.retryLater(job, 'the device could not be read')
      part = parts.value.find((p) => p.partNo === partNo) ?? null
      if (!part) return // sent already (by this tab or another)
    }
    const read = await device.chunksIn(sessionId, part.fromSeq, part.toSeq)
    // a failed read is a failure: the copy stays, and it is tried again
    if (!read.ok && !held) return this.retryLater(job, 'the device could not be read')
    const onDevice = read.ok ? read.value : []
    const expected = part.toSeq - part.fromSeq + 1
    let bufs: ArrayBuffer[]
    if (onDevice.length >= expected) bufs = onDevice.map((c) => c.buf)
    else if (held && held.bufs.length >= onDevice.length) bufs = held.bufs
    else bufs = onDevice.map((c) => c.buf)
    if (onDevice.length > 0 && onDevice.length < expected && bufs !== held?.bufs) {
      this.say(`part ${partNo} of ${sessionId}: the device held ${onDevice.length} of ${expected} pieces; sent what it had`)
    }
    if (bufs.length === 0) {
      // read, and truly empty, with nothing in memory: the record is stale
      this.say(`part ${partNo} of ${sessionId} had nothing left to send; its record is cleared`)
      await device.deletePart(sessionId, partNo)
      return
    }
    const kind = sniff(new Uint8Array(bufs[0].slice(0, 12)))
    const type = kind !== 'application/octet-stream' ? kind : rec?.kind ?? 'video/webm'
    const blob = new Blob(bufs, { type })
    const r = await this.up.put(sessionId, partNo, blob, type, signalFor(blob.size))

    if ('error' in r) {
      // deleted elsewhere: nothing more goes up, and the device copy goes
      if (r.deleted) {
        this.say(`session ${sessionId} was deleted elsewhere; its parts on this device are cleared`)
        return this.forget(sessionId)
      }
      if (r.taken) {
        if (r.taken.size === blob.size) {
          // this very part landed before (its answer was lost on the way back)
          return this.confirmed(sessionId, part)
        }
        // the number holds something else: this part takes a new one, and nothing is written over
        const owner = await this.adopt(sessionId)
        const fresh = owner.nextPart++
        await this.save(owner)
        const moved: PartRec = { ...part, partNo: fresh }
        await device.putPart(moved)
        await device.deletePart(sessionId, partNo)
        if (held) {
          this.mem.delete(this.key(sessionId, partNo))
          this.mem.set(this.key(sessionId, fresh), { part: moved, bufs: held.bufs })
        }
        this.say(`part ${partNo} of ${sessionId} was taken in the cloud by a different piece; sent as part ${fresh} instead`)
        this.enqueue(sessionId, fresh)
        return
      }
      return this.retryLater(job, r.error)
    }
    await this.confirmed(sessionId, part)
    // deleted while it was on its way: said, so the deleter clears it again
    const after = await this.rec(sessionId)
    if (after?.tombstone) this.say(`a part of deleted session ${sessionId} landed during its deletion`)
  }

  /** The cloud has it: only now is the device copy let go. */
  private async confirmed(sessionId: string, part: PartRec): Promise<void> {
    const rec = await this.adopt(sessionId)
    if (!rec.done.some(([n]) => n === part.partNo)) rec.done.push([part.partNo, part.lastAt ?? 0])
    await this.save(rec)
    this.mem.delete(this.key(sessionId, part.partNo))
    await device.deleteChunks(sessionId, part.fromSeq, part.toSeq)
    await device.deletePart(sessionId, part.partNo)
    this.ev.uploaded?.({ sessionId, partNo: part.partNo, ...this.watermark(rec) })
  }

  /** Waits (at most ms) for this session's parts to go up, as far as they will. */
  async waitFor(sessionId: string, ms: number): Promise<void> {
    await this.drained(sessionId, ms)
  }

  /** Waits (at most ms) until nothing of this session is queued or on its way. */
  private async drained(sessionId: string, ms: number): Promise<void> {
    const until = this.now() + ms
    // anything of this session on its way, or due to be tried again inside the allowance
    const mine = (): boolean =>
      [...this.queue.values()].some((j) => j.sessionId === sessionId && j.due <= until) ||
      [...this.running].some((k) => k.startsWith(sessionId + ':'))
    while (mine() && Date.now() < until) {
      await new Promise((r) => setTimeout(r, 100))
    }
  }

  // ---- after a restart, a crash, another tab ----

  /** Is this session being recorded in another tab (it holds the lock)? */
  async heldElsewhere(sessionId: string): Promise<boolean> {
    if (this.live.has(sessionId)) return false
    const l = locks()
    if (!l) return false
    let free = false
    await l.request(lockName(sessionId), { ifAvailable: true }, async (lock) => {
      free = lock !== null
    })
    return !free
  }

  /**
   * Everything on this device the cloud does not have yet, queued again:
   * parts left by a closed tab, and loose pieces that never became a part.
   * Sessions live here or in another tab are left to their recorder.
   * Returns the sessions it found work for.
   */
  async resume(opts: { olderThanMs?: number } = {}): Promise<string[]> {
    const touched = new Set<string>()
    const parts = await device.allParts()
    if (parts.ok) {
      for (const p of parts.value) {
        if (this.live.has(p.sessionId) || (await this.heldElsewhere(p.sessionId))) continue
        const rec = await this.adopt(p.sessionId)
        if (rec.tombstone) {
          await device.deletePart(p.sessionId, p.partNo)
          continue
        }
        touched.add(p.sessionId)
        this.enqueue(p.sessionId, p.partNo)
      }
    }
    for (const sid of await this.sweepLoose(opts.olderThanMs ?? 90000)) touched.add(sid)
    for (const [k, m] of this.mem) {
      touched.add(m.part.sessionId)
      this.enqueue(m.part.sessionId, m.part.partNo)
      void k
    }
    return [...touched]
  }

  /**
   * Pieces on the device that belong to no part (a tab closed between making
   * them and forming the part): made into a part of their own, numbered after
   * every other. Read by keys alone: no recording bytes are loaded to decide.
   */
  async sweepLoose(olderThanMs = 90000): Promise<string[]> {
    const keys = await device.chunkKeys()
    if (!keys.ok) return []
    const bySession = new Map<string, number[]>()
    for (const [sid, seq] of keys.value) {
      const list = bySession.get(sid) ?? []
      list.push(seq)
      bySession.set(sid, list)
    }
    const out: string[] = []
    for (const [sid, seqs] of bySession) {
      if (this.live.has(sid) || (await this.heldElsewhere(sid))) continue
      const parts = await device.partsOf(sid)
      if (!parts.ok) continue
      const covered = (s: number): boolean => parts.value.some((p) => s >= p.fromSeq && s <= p.toSeq)
      const loose = seqs.filter((s) => !covered(s)).sort((a, b) => a - b)
      if (loose.length === 0) continue
      const last = await device.lastChunk(sid)
      if (!last.ok || (last.value && this.now() - last.value.at < olderThanMs)) continue
      const rec = await this.adopt(sid)
      if (rec.tombstone) {
        await device.deleteChunks(sid)
        continue
      }
      // loose pieces in runs: each unbroken run becomes a part, in order
      let run: number[] = []
      const runs: number[][] = []
      for (const s of loose) {
        if (run.length && s !== run[run.length - 1] + 1) {
          runs.push(run)
          run = []
        }
        run.push(s)
      }
      if (run.length) runs.push(run)
      for (const r of runs) {
        const partNo = rec.nextPart++
        await this.save(rec)
        await device.putPart({ sessionId: sid, partNo, fromSeq: r[0], toSeq: r[r.length - 1], lastAt: last.value?.at })
        this.say(`loose recording pieces found for ${sid}: ${r.length} become part ${partNo}`)
        this.enqueue(sid, partNo)
      }
      out.push(sid)
    }
    return out
  }

  // ---- deleting ----

  /** Marked first, so nothing of it goes up again; then its device copy goes. */
  async forget(sessionId: string): Promise<void> {
    const rec = (await this.rec(sessionId)) ?? { sessionId, nextPart: 0, nextSeq: 0, startedAt: this.now(), done: [] }
    rec.tombstone = this.now()
    await this.save(rec)
    const live = this.live.get(sessionId)
    if (live) {
      this.live.delete(sessionId)
      live.release?.()
    }
    for (const k of [...this.queue.keys()]) if (k.startsWith(sessionId + ':')) this.queue.delete(k)
    for (const k of [...this.mem.keys()]) if (k.startsWith(sessionId + ':')) this.mem.delete(k)
    // uploads already on their way are stopped, not left to land after the delete
    for (const c of this.inFlight.get(sessionId) ?? []) c.abort()
    this.inFlight.delete(sessionId)
    await device.deleteChunks(sessionId)
    await device.deleteParts(sessionId)
    await device.deleteHeader(sessionId)
  }

  /** The header kept for a session, for a player repairing a recording whose first part is lost. */
  async header(sessionId: string): Promise<{ buf: ArrayBuffer; kind: string } | null> {
    const h = await device.getHeader(sessionId)
    return h.ok ? h.value : null
  }
  /** What the device holds of a part (for playing a recording before it is all up). */
  async deviceBytes(sessionId: string, partNo: number): Promise<ArrayBuffer[] | null> {
    const held = this.mem.get(this.key(sessionId, partNo))
    const parts = await device.partsOf(sessionId)
    const part = held?.part ?? (parts.ok ? parts.value.find((p) => p.partNo === partNo) : undefined)
    if (!part) return null
    const read = await device.chunksIn(sessionId, part.fromSeq, part.toSeq)
    if (read.ok && read.value.length >= part.toSeq - part.fromSeq + 1) return read.value.map((c) => c.buf)
    return held?.bufs ?? (read.ok && read.value.length ? read.value.map((c) => c.buf) : null)
  }
  /** Part numbers this device still holds for a session. */
  async localPartNos(sessionId: string): Promise<number[]> {
    const parts = await device.partsOf(sessionId)
    const nos = new Set<number>(parts.ok ? parts.value.map((p) => p.partNo) : [])
    for (const m of this.mem.values()) if (m.part.sessionId === sessionId) nos.add(m.part.partNo)
    return [...nos].sort((a, b) => a - b)
  }
  /** How many parts a session has had numbered (the counter): the cloud should hold this many. */
  async partsMade(sessionId: string): Promise<number | null> {
    const rec = await this.rec(sessionId)
    return rec ? rec.nextPart : null
  }
}
