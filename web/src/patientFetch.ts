/**
 * A fetch that does not give up at the first stumble.
 *
 * On a campus or office network a name sometimes fails to resolve, or a
 * connection is refused for a second, and every read the page was waiting on
 * fails at once: the library looks empty, a transcript will not open, the
 * page seems to hang. The work is only ever reading, so asking again a
 * moment later is safe and almost always enough.
 *
 * Only reads are asked again (GET and HEAD). A write that failed on the way
 * out is never repeated here: the caller knows whether repeating it is safe.
 */
const TRIES = [400, 1200] // how long to wait before each further try

export async function patientFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase()
  const readOnly = method === 'GET' || method === 'HEAD'
  let last: unknown
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await fetch(input, init)
      // a gateway that is briefly out of sorts reads like a fault to the
      // page; asked again, it usually answers
      if (readOnly && (res.status === 502 || res.status === 503 || res.status === 504) && attempt < TRIES.length) {
        await new Promise((r) => setTimeout(r, TRIES[attempt]))
        continue
      }
      return res
    } catch (err) {
      last = err
      if (!readOnly || attempt >= TRIES.length) break
      await new Promise((r) => setTimeout(r, TRIES[attempt]))
    }
  }
  throw last
}
