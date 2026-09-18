/**
 * The app inside the extension.
 *
 * Loaded only when app.html runs from a chrome-extension: address. The same
 * app then runs in one of three places:
 *
 *   the engine   an invisible page the extension keeps open while a meeting
 *                is captured; it records, uploads, captions, answers. It is
 *                never seen and never closed by accident: the card on the
 *                meeting page and a viewer tab talk to it through the
 *                background worker;
 *   a viewer     app.html in an ordinary tab, opened from the card, showing
 *                the session as it grows (the engine tells it when to look);
 *   the panel    Chrome's side panel, for anyone who likes it there.
 *
 * Three things the packaged app needs that the website does not: "/api/…"
 * calls go to the website's server; the meeting tab's sound and picture are
 * taken directly, with no picker; and Google sign-in goes through Chrome's
 * own window, since no pop-up can open inside a panel.
 */

interface ChromeTab {
  id?: number
  title?: string
  url?: string
}
interface ChromeLike {
  runtime: {
    sendMessage(msg: unknown, cb?: (reply: unknown) => void): void
    onMessage: {
      addListener(cb: (msg: unknown, sender: unknown, reply: (r: unknown) => void) => boolean | void): void
      removeListener(cb: (msg: unknown) => void): void
    }
    getURL(path: string): string
    lastError?: { message?: string }
  }
  tabs?: {
    query(q: { active: boolean; currentWindow: boolean }): Promise<ChromeTab[]>
    create(o: { url: string; active?: boolean }): Promise<ChromeTab>
  }
  tabCapture?: { getMediaStreamId(o: { targetTabId: number }): Promise<string> }
  identity?: {
    getRedirectURL(path?: string): string
    launchWebAuthFlow(o: { url: string; interactive: boolean }): Promise<string | undefined>
  }
}
declare const chrome: ChromeLike

export const IN_EXTENSION = location.protocol === 'chrome-extension:'
/** the invisible page that records: app.html opened by the worker with this mark */
export const IN_ENGINE = IN_EXTENSION && location.hash === '#engine'
const API_ORIGIN = (import.meta.env.VITE_API_ORIGIN as string | undefined) || 'https://sitcaai.vercel.app'

/** A capture the app was asked for: the meeting tab, and what to do with it. */
export interface MeetRequest {
  tabId: number
  title: string
  url: string
  /** when it was asked for: a second press is a second request, not a repeat */
  at: number
  /** record for this person, or host it on Sitca with a link for the room */
  mode: 'record' | 'host'
  /** the engine only: Chrome's handle on the tab's sound and picture */
  streamId?: string
}

/** Every "/api/…" request goes to the website's server. Done once, first thing. */
export function pointApiAtServer(): void {
  const real = window.fetch.bind(window)
  window.fetch = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    if (url.startsWith('/api/')) return real(API_ORIGIN + url, init)
    return real(input, init)
  }
}

function send<T = unknown>(msg: unknown): Promise<T> {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage(msg, (reply) => {
        void chrome.runtime.lastError
        resolve(reply as T)
      })
    } catch {
      resolve(undefined as T)
    }
  })
}

// ---------- the meeting tab's sound and picture ----------

let keepAudible: HTMLAudioElement | null = null
/** the handle the worker sent along with the request, used once */
let pendingStreamId: string | null = null
/** the last tab captured: released before another is taken, or on request */
let lastStream: MediaStream | null = null

/** Let go of the tab: Chrome allows one capture of a tab at a time. */
export function releaseTab(): void {
  try {
    lastStream?.getTracks().forEach((t) => t.stop())
  } catch {
    /* ignore */
  }
  lastStream = null
  keepAudible?.pause()
  keepAudible = null
}

/**
 * The meeting tab as a stream a live session records. Chrome stops playing
 * a captured tab's sound to the person unless the capturer plays it, so it
 * is played here as well: the lecturer keeps hearing their class.
 */
export async function captureTab(tabId?: number): Promise<MediaStream> {
  releaseTab()
  let streamId = pendingStreamId
  pendingStreamId = null
  if (!streamId) {
    if (!chrome.tabCapture || !chrome.tabs) throw new Error('The meeting tab could not be captured from here.')
    let target = tabId
    if (target === undefined) {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
      target = tab?.id
    }
    if (target === undefined) throw new Error('No meeting tab to capture.')
    try {
      streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: target })
    } catch (err) {
      const m = err instanceof Error ? err.message : String(err)
      if (/invoked|activeTab|not been|permission/i.test(m)) {
        throw new Error('Press the Sitca icon in Chrome’s toolbar to capture this meeting. That press is what lets Chrome share the call with Sitca.')
      }
      throw new Error(`The meeting tab could not be captured: ${m}`)
    }
  }
  const md = navigator.mediaDevices as unknown as { getUserMedia: (c: unknown) => Promise<MediaStream> }
  const stream = await md.getUserMedia({
    audio: { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: streamId } },
    video: {
      mandatory: {
        chromeMediaSource: 'tab',
        chromeMediaSourceId: streamId,
        maxWidth: 1280,
        maxHeight: 720,
        maxFrameRate: 12
      }
    }
  })
  lastStream = stream
  try {
    keepAudible?.pause()
    const a = new Audio()
    a.srcObject = new MediaStream(stream.getAudioTracks())
    a.volume = 1
    void a.play().catch(() => undefined)
    keepAudible = a
    stream.getAudioTracks()[0]?.addEventListener('ended', () => {
      a.pause()
      if (keepAudible === a) keepAudible = null
    })
  } catch {
    /* the recording is unaffected */
  }
  return stream
}

// ---------- the microphone ----------

/**
 * Chrome never shows the microphone prompt inside a side panel or an
 * invisible page, so a small page of the extension's own is opened in a
 * tab, where it does ask. The answer belongs to the whole extension, so this
 * happens once, ever. The call's sound carries everyone else; this adds the
 * person at this computer, which for a lecturer is the voice that matters.
 */
export async function ensureMic(): Promise<boolean> {
  try {
    const st = await navigator.permissions.query({ name: 'microphone' as PermissionName })
    if (st.state === 'granted') return true
  } catch {
    /* a browser that will not say: ask the page */
  }
  return new Promise<boolean>((resolve) => {
    let done = false
    const finish = (ok: boolean): void => {
      if (done) return
      done = true
      try {
        chrome.runtime.onMessage.removeListener(listener)
      } catch {
        /* ignore */
      }
      resolve(ok)
    }
    const listener = (msg: unknown): void => {
      const m = msg as { type?: string; ok?: boolean }
      if (m && m.type === 'sitca:mic') finish(Boolean(m.ok))
    }
    chrome.runtime.onMessage.addListener(listener)
    // the worker opens the page: the engine has no tabs API of its own
    void send({ type: 'sitca:mic:ask' })
    // a tab left unanswered must not hold the session up for ever
    setTimeout(() => finish(false), 90000)
  })
}

// ---------- requests reaching the app ----------

/**
 * Hear what this page was opened for. In the engine, the worker sends the
 * request itself, with Chrome's handle on the tab; in the panel, a request
 * that arrived before the app was ready is asked for on arrival.
 */
export function listenForMeetings(onRequest: (req: MeetRequest) => void): void {
  const seen = new Set<string>()
  const take = (m: unknown): void => {
    const r = m as Partial<MeetRequest>
    if (!r || typeof r.tabId !== 'number') return
    const at = r.at ?? Date.now()
    const key = `${r.tabId}:${at}`
    if (seen.has(key)) return
    seen.add(key)
    if (r.streamId) pendingStreamId = r.streamId
    onRequest({ tabId: r.tabId, title: r.title || '', url: r.url || '', at, mode: r.mode === 'host' ? 'host' : 'record' })
  }
  chrome.runtime.onMessage.addListener((msg) => {
    const m = msg as { type?: string }
    // the engine takes the worker's start order; the panel takes a capture
    // it was opened for; neither takes the other's
    if (m && m.type === (IN_ENGINE ? 'sitca:engine:start' : 'sitca:capture')) take(msg)
    return undefined
  })
  if (!IN_ENGINE && chrome.tabs) {
    void chrome.tabs.query({ active: true, currentWindow: true }).then(([tab]) => {
      if (tab?.id === undefined) return
      void send({ type: 'sitca:pending', tabId: tab.id }).then((reply) => {
        if (reply) take(reply)
      })
    })
  }
}

/** The page is done with a request (the session started, or was declined). */
export function meetingDone(tabId: number): void {
  void send({ type: 'sitca:done', tabId })
}

/** From a viewer: back to the meeting tab the session is being captured from. */
export function focusMeeting(): void {
  void send({ type: 'sitca:focus-meeting' })
}

// ---------- the engine's side of the conversation ----------

/** What the engine tells the worker, which tells the card and the viewer. */
export interface EngineStatus {
  state: 'starting' | 'recording' | 'ending' | 'ended' | 'failed' | 'idle'
  tabId?: number
  sessionId?: string
  startedAt?: number
  title?: string
  /** hosting: the link for the room, and its QR as a picture */
  hostUrl?: string
  qr?: string
  /** once ended: the recap link to share */
  recapUrl?: string
  /** the latest thing heard */
  lastLine?: string
  error?: string
}

/** The engine is up and signed in (or not): the worker may send a request. */
export function engineReady(signedIn: boolean): void {
  void send({ type: 'sitca:engine:ready', signedIn })
}

/**
 * Wire the engine: status out (from window events the session page fires),
 * orders in (stop, a question, a caption heard on the meeting page).
 */
export function engineBridge(): void {
  window.addEventListener('sitka:engine:status', (e) => {
    const s = (e as CustomEvent<EngineStatus>).detail
    void send({ type: 'sitca:engine:status', ...s })
  })
  chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
    const m = msg as { type?: string; text?: string; who?: string; at?: number; end?: number; sessionId?: string; final?: boolean }
    if (!m || typeof m.type !== 'string') return undefined
    // the worker, restarted by Chrome, checking whether the engine it left is still here
    if (m.type === 'sitca:engine:ping') {
      const signedIn = Boolean((window as unknown as { sitka?: unknown }).sitka)
      reply({ ready: true, signedIn })
      return undefined
    }
    if (m.type === 'sitca:engine:stop') {
      window.dispatchEvent(new CustomEvent('sitka:stop'))
      reply({ ok: true })
      return undefined
    }
    if (m.type === 'sitca:engine:release') {
      releaseTab()
      reply({ ok: true })
      return undefined
    }
    if (m.type === 'sitca:engine:caption') {
      window.dispatchEvent(new CustomEvent('sitka:caption', { detail: { who: m.who || '', text: m.text || '', at: m.at || Date.now(), end: m.end } }))
      reply({ ok: true })
      return undefined
    }
    if (m.type === 'sitca:engine:ask') {
      void askFromCard(m.sessionId || '', m.text || '').then((answer) => reply({ answer }))
      return true // answered later
    }
    return undefined
  })
}

/** A question typed into the card on the meeting page, answered by the session's Ask. */
async function askFromCard(sessionId: string, question: string): Promise<string> {
  const q = question.trim()
  if (!sessionId || !q) return ''
  const api = (window as unknown as {
    sitka?: {
      askAi: (r: { sessionId: string; requestId: string; question: string; live: boolean; history: unknown[] }) => Promise<unknown>
      onAiStream: (cb: (e: { requestId: string; type: string; text?: string; error?: string }) => void) => () => void
    }
  }).sitka
  if (!api) return 'Sitca is still opening. Try again in a moment.'
  const requestId = Math.random().toString(36).slice(2)
  return new Promise<string>((resolve) => {
    let out = ''
    const off = api.onAiStream((e) => {
      if (e.requestId !== requestId) return
      if (e.type === 'delta') out += e.text || ''
      if (e.type === 'done') {
        off()
        resolve(out.trim())
      }
      if (e.type === 'error') {
        off()
        resolve(out.trim() || e.error || 'Sitca could not answer just now.')
      }
    })
    void api.askAi({ sessionId, requestId, question: q, live: true, history: [] }).catch((err) => {
      off()
      resolve(err instanceof Error ? err.message : String(err))
    })
    setTimeout(() => {
      off()
      resolve(out.trim() || 'Sitca took too long to answer. Try again.')
    }, 60000)
  })
}

// ---------- Google sign-in from inside the panel ----------

/**
 * Chrome opens Google's own window; Google comes back with its ID token,
 * the same proof the website's button produces. The redirect address is the
 * extension's own, and must be listed on the Google client.
 */
export async function googleIdTokenViaChrome(clientId: string): Promise<{ token: string; nonce: string }> {
  if (!chrome.identity) throw new Error('Google sign-in is not available here. Open Sitca in a tab to sign in.')
  const nonce = Array.from(crypto.getRandomValues(new Uint8Array(24)), (b) => b.toString(16).padStart(2, '0')).join('')
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(nonce))
  const stamped = Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('')
  const redirect = chrome.identity.getRedirectURL('google')
  const url =
    'https://accounts.google.com/o/oauth2/v2/auth?' +
    new URLSearchParams({
      client_id: clientId,
      response_type: 'id_token',
      redirect_uri: redirect,
      scope: 'openid email profile',
      nonce: stamped,
      prompt: 'select_account'
    })
  const back = await chrome.identity.launchWebAuthFlow({ url, interactive: true })
  if (!back) throw new Error('The Google window was closed before you chose an account.')
  const hash = new URL(back).hash.replace(/^#/, '')
  const token = new URLSearchParams(hash).get('id_token')
  if (!token) {
    const why = new URLSearchParams(hash).get('error') || new URL(back).searchParams.get('error') || ''
    throw new Error(
      /redirect_uri/i.test(why)
        ? `Google does not know this extension's address yet: add ${redirect} to the client's redirect URIs.`
        : 'Google did not say who you are. Try again.'
    )
  }
  return { token, nonce }
}
