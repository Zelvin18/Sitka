// The recording engine (Set 3), drilled on an in-memory IndexedDB with the
// failures both reports describe: a device read that fails, a device write
// that fails, an upload that hangs, a number already taken in the cloud, a
// session deleted mid-recording, a tab that died before its pieces became a
// part, another tab holding the recording.

import 'fake-indexeddb/auto'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { RecordingEngine, device } from '../../web/src/recorder.ts'

const MB = 1024 * 1024
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const sid = () => randomUUID()

/** a WebM-looking first piece, then plain bytes */
function piece(i, size = MB) {
  const b = new Uint8Array(size)
  b.fill(i % 250)
  if (i === 0) b.set([0x1a, 0x45, 0xdf, 0xa3])
  return b.buffer
}

/** A cloud that can be told to fail, hang or already hold numbers. */
function cloud() {
  const c = {
    parts: new Map(), // `${sid}:${n}` -> size
    headers: new Map(),
    puts: [],
    failNext: new Map(), // partNo -> times to fail
    failWhile: null, // (sessionId, partNo) => true while that part should fail
    hang: false,
    taken: new Map(), // `${sid}:${n}` -> size already there
    listing: null, // numbers cloudParts() answers, or null
    async put(sessionId, partNo, blob, kind, signal) {
      c.puts.push({ sessionId, partNo, size: blob.size, kind })
      if (c.hang) {
        return new Promise((resolve) => signal.addEventListener('abort', () => resolve({ error: 'timed out' })))
      }
      const t = c.taken.get(`${sessionId}:${partNo}`)
      if (t !== undefined) return { error: 'taken', taken: { size: t } }
      if (c.failWhile && c.failWhile(sessionId, partNo)) return { error: 'storage answered 503' }
      const f = c.failNext.get(partNo) || 0
      if (f > 0) {
        c.failNext.set(partNo, f - 1)
        return { error: 'storage answered 503' }
      }
      c.parts.set(`${sessionId}:${partNo}`, blob.size)
      return { ok: true }
    },
    async putHeader(sessionId, blob) {
      c.headers.set(sessionId, blob.size)
      return { ok: true }
    },
    async cloudParts() {
      return c.listing
    },
    numbers(sessionId) {
      return [...c.parts.keys()].filter((k) => k.startsWith(sessionId + ':')).map((k) => Number(k.split(':')[1])).sort((a, b) => a - b)
    }
  }
  return c
}

function engine(up, extra = {}) {
  const said = { uploaded: [], trouble: [], device: [], report: [] }
  const e = new RecordingEngine({
    uploader: up,
    partBytes: 3 * MB,
    backoff: [30, 60, 90],
    timeoutFor: () => 2000,
    events: {
      // with what the cloud truly holds at that moment, to hold "up to" against
      uploaded: (d) => said.uploaded.push({ ...d, cloudNow: up.numbers ? up.numbers(d.sessionId) : [] }),
      trouble: (d) => said.trouble.push(d),
      deviceCopy: (d) => said.device.push(d),
      report: (m) => said.report.push(m)
    },
    ...extra
  })
  return { e, said }
}

async function record(e, id, n, size = MB) {
  await e.begin(id)
  for (let i = 0; i < n; i++) await e.add(id, piece(i, size))
}

async function waitFor(fn, ms = 5000) {
  const until = Date.now() + ms
  while (Date.now() < until) {
    if (await fn()) return true
    await sleep(20)
  }
  return false
}

test('a recording goes up part by part, in order, and leaves nothing on the device', async () => {
  const up = cloud()
  const { e, said } = engine(up)
  const id = sid()
  await record(e, id, 10)
  const { left } = await e.end(id, 5000)
  assert.equal(left, 0)
  assert.deepEqual(up.numbers(id), [0, 1, 2, 3])
  assert.equal([...up.parts.entries()].filter(([k]) => k.startsWith(id)).reduce((n, [, s]) => n + s, 0), 10 * MB)
  const keys = await device.chunkKeysOf(id)
  assert.deepEqual(keys.value, [])
  assert.equal(said.uploaded.at(-1).upToPart, 3)
})

test('W1: the header is kept on its own and sent beside the parts', async () => {
  const up = cloud()
  const { e } = engine(up)
  const id = sid()
  await record(e, id, 4)
  await e.end(id, 5000)
  assert.ok(await waitFor(() => up.headers.has(id)))
  const h = await e.header(id)
  assert.equal(h.kind, 'video/webm')
  assert.equal(h.buf.byteLength, MB)
})

test('R2: a device read that fails never deletes the copy; the part goes up later', async () => {
  const up = cloud()
  const { e, said } = engine(up)
  const id = sid()
  const real = device.chunksIn
  let fails = 2
  device.chunksIn = async (...a) => (fails-- > 0 ? { ok: false } : real(...a))
  try {
    await record(e, id, 3)
    await e.end(id, 5000)
    assert.ok(said.trouble.some((t) => /could not be read/.test(t.error)))
    assert.ok(await waitFor(() => up.numbers(id).length === 1))
    assert.equal(up.parts.get(`${id}:0`), 3 * MB, 'the whole part, not an empty one')
  } finally {
    device.chunksIn = real
  }
})

test('R1/M3: numbers come from the counter; a late piece is numbered after every other', async () => {
  const up = cloud()
  const { e } = engine(up)
  const id = sid()
  await record(e, id, 7)
  await e.end(id, 5000)
  const late = await e.add(id, piece(99, 200 * 1024))
  assert.equal(late.late, true)
  assert.equal(late.partNo, 3)
  assert.ok(await waitFor(() => up.numbers(id).includes(3)))
  assert.deepEqual(up.numbers(id), [0, 1, 2, 3])
  assert.equal(up.parts.get(`${id}:0`), 3 * MB, 'part 0 was written over')
})

test('R1: a session this device never saw is numbered past what the cloud holds', async () => {
  const up = cloud()
  const { e } = engine(up)
  const id = sid()
  up.listing = [0, 1, 2, 3, 4]
  const late = await e.add(id, piece(5, 100))
  assert.equal(late.partNo, 5)
})

test('R1: a number already holding something else is never written over', async () => {
  const up = cloud()
  const { e, said } = engine(up)
  const id = sid()
  up.listing = null // the cloud could not be listed: the counter starts at 0
  up.taken.set(`${id}:0`, 12345) // but part 0 is already there, and different
  const late = await e.add(id, piece(1, 500))
  assert.equal(late.partNo, 0)
  assert.ok(await waitFor(() => up.numbers(id).includes(1)))
  assert.ok(!up.parts.has(`${id}:0`))
  assert.ok(said.report.some((m) => /sent as part 1 instead/.test(m)))
})

test('R1: a part that already landed (its answer lost) is not sent twice', async () => {
  const up = cloud()
  const { e } = engine(up)
  const id = sid()
  up.listing = null
  up.taken.set(`${id}:0`, 700)
  await e.add(id, piece(1, 700))
  assert.ok(await waitFor(async () => (await e.pending(id)) === 0))
  assert.deepEqual(up.numbers(id), [], 'no duplicate part was made')
})

test('R3/R4: a failed part is retried during the recording, and "up to" never skips a gap', async () => {
  const up = cloud()
  const { e, said } = engine(up)
  const id = sid()
  // part 1 is refused until part 2 is in: a gap, every time, however fast the machine
  up.failWhile = (s, n) => s === id && n === 1 && !up.parts.has(`${id}:2`)
  await record(e, id, 9)
  assert.ok(await waitFor(() => said.uploaded.some((u) => u.sessionId === id && u.upToPart === 2)), 'part 1 was not retried while recording')
  // "up to" never claims more than the cloud holds with no gap, whatever order parts land in
  for (const u of said.uploaded.filter((x) => x.sessionId === id)) {
    const have = new Set(u.cloudNow)
    let n = -1
    while (have.has(n + 1)) n++
    assert.ok(u.upToPart <= n, `"up to" said part ${u.upToPart} while the cloud held ${[...have]} (gap-free to ${n})`)
  }
  // the drill did make a gap: part 2 was in the cloud while part 1 was not
  const refusedFirst = up.puts.findIndex((p) => p.sessionId === id && p.partNo === 1)
  const twoIn = up.puts.findIndex((p) => p.sessionId === id && p.partNo === 2)
  assert.ok(refusedFirst >= 0 && twoIn >= 0 && said.trouble.some((t) => t.sessionId === id), 'this drill did not test a gap')
  await e.end(id, 5000)
})

test('R4: pieces the device could not keep are held in memory, sent, then let go', async () => {
  const up = cloud()
  const { e, said } = engine(up)
  const id = sid()
  const real = device.putChunk
  device.putChunk = async () => false
  try {
    await record(e, id, 4)
    assert.ok(said.device.some((d) => d.sessionId === id && d.ok === false))
    const { left } = await e.end(id, 5000)
    assert.equal(left, 0)
    assert.equal(up.parts.get(`${id}:0`), 3 * MB)
    assert.equal(up.parts.get(`${id}:1`), MB)
    assert.equal(e.busy(), false, 'memory was not let go')
  } finally {
    device.putChunk = real
  }
})

test('R4: memory is let go as soon as the device has confirmed its copy', async () => {
  const up = cloud()
  up.hang = true // nothing goes up: the device copy is all there is
  const { e } = engine(up, { timeoutFor: () => 60000 })
  const id = sid()
  await record(e, id, 6)
  await sleep(50)
  assert.equal(e.mem.size, 0)
  await e.forget(id)
})

test('R7: an upload that hangs is given up on and tried again; ending waits only so long', async () => {
  const up = cloud()
  up.hang = true
  const { e } = engine(up, { timeoutFor: () => 100 })
  const id = sid()
  await record(e, id, 3)
  const t0 = Date.now()
  const { left } = await e.end(id, 400)
  assert.ok(Date.now() - t0 < 2000, 'ending hung')
  assert.equal(left, 1, 'the part stays on the device')
  up.hang = false
  assert.ok(await waitFor(() => up.numbers(id).length === 1, 3000), 'the part was not tried again')
})

test('R14: a deleted session sends nothing more, and keeps nothing on the device', async () => {
  const up = cloud()
  up.hang = true
  const { e } = engine(up, { timeoutFor: () => 60000 })
  const id = sid()
  await record(e, id, 4)
  await e.forget(id)
  up.hang = false
  const before = up.puts.filter((p) => p.sessionId === id).length
  await e.add(id, piece(9, MB)) // the recorder's last piece, arriving after the delete
  await sleep(300)
  assert.equal(up.puts.filter((p) => p.sessionId === id).length, before, 'something of a deleted session was sent')
  assert.deepEqual((await device.chunkKeysOf(id)).value, [])
  assert.deepEqual((await device.partsOf(id)).value, [])
  assert.equal(up.numbers(id).length, 0)
})

test('R11/M2: pieces a closed tab never grouped become a part, found by keys alone', async () => {
  const up = cloud()
  const { e } = engine(up)
  const id = sid()
  const old = Date.now() - 10 * 60000
  for (let s = 0; s < 4; s++) await device.putChunk({ sessionId: id, seq: s, at: old, buf: piece(s, 500 * 1024) })
  const real = device.chunksIn
  let bodyReads = 0
  device.chunksIn = async (...a) => {
    bodyReads++
    return real(...a)
  }
  try {
    const found = await e.sweepLoose(90000)
    assert.deepEqual(found, [id])
    assert.equal(bodyReads, 0, 'the sweep read recording bytes to decide')
    assert.ok(await waitFor(() => up.numbers(id).length === 1))
    assert.equal(up.parts.get(`${id}:0`), 4 * 500 * 1024)
  } finally {
    device.chunksIn = real
  }
})

test('a part left by the older recorder (no counter, no end time) still goes up', async () => {
  const up = cloud()
  const { e } = engine(up)
  const id = sid()
  for (let s = 0; s < 3; s++) await device.putChunk({ sessionId: id, seq: s, at: Date.now() - 600000, buf: piece(s, 100 * 1024) })
  await device.putPart({ sessionId: id, partNo: 0, fromSeq: 0, toSeq: 2 })
  const found = await e.resume()
  assert.ok(found.includes(id))
  assert.ok(await waitFor(() => up.numbers(id).length === 1))
  assert.ok(await waitFor(async () => (await e.pending(id)) === 0), 'the device copy was not let go after the cloud confirmed it')
})

test('R10/R11: a session recorded in another tab is left to that tab', async () => {
  const held = new Set()
  const prev = globalThis.navigator
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: {
      locks: {
        async request(name, opts, fn) {
          if (opts.ifAvailable && held.has(name)) return fn(null)
          held.add(name)
          try {
            return await fn({ name })
          } finally {
            held.delete(name)
          }
        }
      }
    }
  })
  try {
    const upA = cloud()
    const upB = cloud()
    upA.hang = true // tab A's parts wait on the device, where tab B could see them
    const a = engine(upA, { timeoutFor: () => 60000 }).e
    const b = engine(upB).e
    const id = sid()
    await record(a, id, 7) // tab A records and holds the lock
    await sleep(20)
    assert.equal(await b.heldElsewhere(id), true)
    const found = await b.resume({ olderThanMs: 0 })
    await sleep(150)
    assert.ok(!found.includes(id), 'tab B took work from a live recording')
    assert.equal(upB.puts.filter((p) => p.sessionId === id).length, 0, 'tab B sent parts of a recording live in tab A')
    upA.hang = false
    await a.end(id, 5000)
    assert.equal(await b.heldElsewhere(id), false)
  } finally {
    Object.defineProperty(globalThis, 'navigator', { configurable: true, value: prev })
  }
})

// ---------- the second audit ----------

test('re-audit N4: a session deleted on another device stops sending here, and its copy here goes', async () => {
  const up = cloud()
  const gone = new Set()
  const put = up.put
  up.put = async (sessionId, partNo, blob, kind, signal) => (gone.has(sessionId) ? { error: 'This session was deleted.', deleted: true } : put(sessionId, partNo, blob, kind, signal))
  const { e } = engine(up)
  const id = sid()
  await record(e, id, 4)
  assert.ok(await waitFor(() => up.numbers(id).length === 1))
  gone.add(id)
  for (let i = 4; i < 10; i++) await e.add(id, piece(i))
  assert.ok(await waitFor(async () => (await device.chunkKeysOf(id)).value.length === 0), 'the device copy of a deleted session was not cleared')
  const sentAfter = up.puts.filter((p) => p.sessionId === id).length
  await sleep(300)
  assert.equal(up.puts.filter((p) => p.sessionId === id).length, sentAfter, 'it kept trying to send a deleted session')
  assert.deepEqual((await device.partsOf(id)).value, [])
})

test('re-audit R8: deleting stops an upload already on its way', async () => {
  const up = cloud()
  up.hang = true
  const { e } = engine(up, { timeoutFor: () => 60000 })
  const id = sid()
  await record(e, id, 4)
  assert.ok(await waitFor(() => up.puts.some((p) => p.sessionId === id)))
  const started = Date.now()
  await e.forget(id)
  // the hanging upload answers as soon as its signal is aborted, not after its minute
  assert.ok(await waitFor(() => !e.busy(), 2000), 'the upload was left running after the delete')
  assert.ok(Date.now() - started < 2000)
})

test('re-audit N11: uploads work where AbortSignal.timeout does not exist (iPhones before iOS 16)', async () => {
  const had = AbortSignal.timeout
  // eslint-disable-next-line no-global-assign
  delete AbortSignal.timeout
  try {
    assert.equal(typeof AbortSignal.timeout, 'undefined')
    const up = cloud()
    const { e } = engine(up)
    const id = sid()
    await record(e, id, 4)
    const { left } = await e.end(id, 5000)
    assert.equal(left, 0)
    assert.deepEqual(up.numbers(id), [0, 1])
  } finally {
    AbortSignal.timeout = had
  }
})

test('re-audit N35: "in the cloud up to" counts from the first piece, not from when the session was made', async () => {
  // a clock that runs with real time, plus whatever the test skips ahead
  let skip = 0
  const up = cloud()
  const { e, said } = engine(up, { now: () => Date.now() + skip })
  const id = sid()
  // the session was made a minute before recording began (the screen picker, permissions)
  await e.begin(id, Date.now())
  skip += 60000
  for (let i = 0; i < 4; i++) {
    skip += 3000
    await e.add(id, piece(i))
  }
  await e.end(id, 5000)
  const last = said.uploaded.filter((u) => u.sessionId === id && u.upToPart === 1).at(-1)
  assert.ok(last, 'nothing was said to be up')
  // four pieces of three seconds: about twelve seconds, never seventy-two
  assert.ok(last.upToMs <= 15000, `said up to ${last.upToMs} ms`)
})
