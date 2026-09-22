// Sitca's extension: the worker that holds it together.
//
// Three places, one conversation.
//   The card    drawn on the Google Meet or Zoom page by meet.js: one button,
//               then a small bar while the session runs. It never records.
//   The engine  app.html opened invisibly (Chrome's "offscreen document"):
//               the whole Sitca app, signed in, recording the meeting tab,
//               captioning, uploading, answering. Nobody can close it by
//               accident; it is closed here once its work is done.
//   The viewer  app.html in an ordinary tab, opened from the card, showing
//               the session as it grows.
//
// Two of Chrome's rules shape the code.
//   A tab may only be captured once the person has invited the extension in,
//   which only a press on the toolbar icon, the right-click menu or the
//   keyboard shortcut counts as. The card asks; when Chrome refuses, the card
//   points at the icon, and the next press on the icon carries on from there.
//   The side panel may only be opened in the same instant as such a press.

const MEETING = /^https:\/\/(meet\.google\.com\/[a-z]{3}-[a-z]{4}-[a-z]{3}|[a-z0-9.-]*zoom\.us\/(wc|j)\/|teams\.(microsoft|live)\.com\/|teams\.cloud\.microsoft\/|(www\.|m\.)?youtube\.com\/(watch|live\/)|[a-z0-9.-]*webex\.com\/(meet|join|wbxmjs|webappng)|[a-z0-9.-]*whereby\.com\/[^/?#]+)/
const APP = chrome.runtime.getURL('app.html')
/** the website: a finished session is opened there, where its recording plays */
const SITE = 'https://sitcaai.vercel.app/app'
/** the extension's own page on the website: opened once, the moment it is installed */
const WELCOME = 'https://sitcaai.vercel.app/extension#installed'

/** one session per meeting tab: what the card shows */
const cards = new Map()
/** a choice the card made before Chrome allowed the capture: kept for the icon press */
const wanted = new Map()
/** the engine page: whether it is up and signed in */
const engine = { starting: null, ready: false, signedIn: false, waiting: [] }
/** cards waiting for the courses the engine reports; asked once per worker life */
const coursesWaiters = []
let coursesAsked = false

// Chrome stops this worker after half a minute of quiet and starts it again
// on the next event, with its memory gone. What the cards show, and a choice
// waiting for the icon press, are kept in session storage so nothing is
// asked twice.
/** a capture asked for before anyone was signed in: picked up the moment they are */
let signinFor = null
const remembered = (async () => {
  try {
    const s = await chrome.storage.session.get(['cards', 'wanted', 'signinFor'])
    for (const [k, v] of Object.entries(s.cards || {})) cards.set(Number(k), v)
    for (const [k, v] of Object.entries(s.wanted || {})) wanted.set(Number(k), v)
    if (s.signinFor && typeof s.signinFor.tabId === 'number') signinFor = s.signinFor
  } catch {
    /* nothing kept */
  }
})()
function remember() {
  const c = {}
  for (const [k, v] of cards) c[k] = v
  const w = {}
  for (const [k, v] of wanted) w[k] = v
  chrome.storage.session.set({ cards: c, wanted: w, signinFor }).catch(() => undefined)
}

chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false }).catch(() => undefined)
chrome.runtime.onInstalled.addListener((details) => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false }).catch(() => undefined)
  if (details && details.reason === 'install') {
    // the first time only: the page that says to pin the icon and sign in
    chrome.tabs.create({ url: WELCOME, active: true }).catch(() => undefined)
  }
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: 'sitca-capture',
      title: 'Capture this with Sitca',
      contexts: ['page'],
      documentUrlPatterns: [
        'https://meet.google.com/*',
        'https://*.zoom.us/*',
        'https://teams.microsoft.com/*',
        'https://teams.live.com/*',
        'https://teams.cloud.microsoft/*',
        'https://*.youtube.com/*',
        'https://*.webex.com/*',
        'https://*.whereby.com/*'
      ]
    })
  })
})

// ---------- the card ----------

function cardOf(tabId) {
  return cards.get(tabId) || { state: 'idle' }
}
function setCard(tabId, patch) {
  const next = { ...cardOf(tabId), ...patch, tabId }
  cards.set(tabId, next)
  remember()
  chrome.tabs.sendMessage(tabId, { type: 'sitca:card', card: next }).catch(() => undefined)
  return next
}
/** the card's choice, kept for the icon press: how to capture, and which course to file it in */
function want(tabId, mode, spaceId) {
  if (mode) wanted.set(tabId, { mode, spaceId: spaceId || '' })
  else wanted.delete(tabId)
  remember()
}
function recordingTab() {
  for (const [tabId, c] of cards) if (c.state === 'recording' || c.state === 'starting' || c.state === 'ending') return tabId
  return null
}

// ---------- the engine ----------

/** Is an engine page already up? Chrome restarts this worker and forgets. */
function pingEngine() {
  return new Promise((resolve) => {
    let done = false
    const finish = (v) => {
      if (!done) {
        done = true
        resolve(v)
      }
    }
    chrome.runtime.sendMessage({ type: 'sitca:engine:ping' }).then(
      (r) => finish(r && r.ready ? r : null),
      () => finish(null)
    )
    setTimeout(() => finish(null), 3000)
  })
}

async function ensureEngine() {
  if (engine.ready) return engine
  if (!engine.starting) {
    engine.starting = (async () => {
      let has = await chrome.offscreen.hasDocument().catch(() => false)
      if (has) {
        // left by an earlier run of this worker: still answering?
        const alive = await pingEngine()
        if (alive) {
          engine.ready = true
          engine.signedIn = Boolean(alive.signedIn)
          return
        }
        await chrome.offscreen.closeDocument().catch(() => undefined)
        has = false
      }
      if (!has) {
        await chrome.offscreen.createDocument({
          url: 'app.html#engine',
          // it records (USER_MEDIA) and plays the call back so the person
          // keeps hearing it (AUDIO_PLAYBACK); with both, Chrome keeps it open
          reasons: ['USER_MEDIA', 'AUDIO_PLAYBACK'],
          justification: 'Records the meeting in this tab for the person, with their microphone, and captions it.'
        })
      }
      // the engine says when it is up (or that nobody is signed in)
      if (engine.ready) return
      await new Promise((resolve) => {
        engine.waiting.push(resolve)
        setTimeout(resolve, 45000)
      })
    })().finally(() => {
      engine.starting = null
    })
  }
  await engine.starting
  return engine
}

/** how many minutes the engine may be left to finish uploads after its last session */
const BUSY_WAIT_MAX = 20
let busyWaits = 0
async function closeEngineIfIdle() {
  await remembered
  if (recordingTab() !== null) return
  try {
    const has = await chrome.offscreen.hasDocument()
    // a start may have begun during that wait
    if (recordingTab() !== null) return
    if (has) {
      // still sending the last parts up, or joining them into the whole
      // file: closed now, that work would be lost. Asked again in a minute.
      const alive = await pingEngine()
      if (alive && alive.busy && busyWaits < BUSY_WAIT_MAX) {
        busyWaits++
        scheduleEngineClose()
        return
      }
      busyWaits = 0
      await chrome.offscreen.closeDocument()
    }
  } catch {
    /* already gone */
  }
  engine.ready = false
  engine.signedIn = false
}

// The engine goes a minute after its last session ends. An alarm, not a
// timer: Chrome stops this worker after half a minute of quiet and a timer
// would go with it, leaving the engine (and its hold on the tab) behind.
const CLOSE_ALARM = 'sitca-close-engine'
function scheduleEngineClose() {
  chrome.alarms.create(CLOSE_ALARM, { delayInMinutes: 1 })
}
function clearEngineClose() {
  chrome.alarms.clear(CLOSE_ALARM).catch(() => undefined)
}
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === CLOSE_ALARM) void closeEngineIfIdle()
})

// ---------- starting a session ----------

/** the keyboard shortcut as Chrome shows it on this computer ('' when none) */
async function shortcut() {
  try {
    const all = await chrome.commands.getAll()
    const c = all.find((x) => x.name === 'capture')
    return (c && c.shortcut) || ''
  } catch {
    return ''
  }
}

/**
 * Chrome's handle on the tab. Chrome allows one capture of a tab at a time:
 * when an earlier one is still held (a session that ended untidily), the
 * engine is asked to let go and the handle is asked for once more.
 */
async function askHandle(tabId) {
  try {
    return await chrome.tabCapture.getMediaStreamId({ targetTabId: tabId })
  } catch (err) {
    const m = String((err && err.message) || err)
    if (!/active stream/i.test(m)) throw err
    await chrome.runtime.sendMessage({ type: 'sitca:engine:release' }).catch(() => undefined)
    await new Promise((r) => setTimeout(r, 600))
    return chrome.tabCapture.getMediaStreamId({ targetTabId: tabId })
  }
}

/**
 * Capture this meeting tab. Chrome's handle on the tab is asked for first:
 * that is the step Chrome refuses until the icon has been pressed, and it
 * is better to learn that before the engine is woken.
 */
async function startCapture(tab, mode, spaceId) {
  if (!tab || !tab.id) return { ok: false }
  const tabId = tab.id
  const busy = recordingTab()
  if (busy !== null && busy !== tabId) {
    setCard(tabId, { state: 'busy' })
    return { ok: false, busy: true }
  }
  if (cardOf(tabId).state === 'ending') {
    // the last one is still being saved: the card shows that, and turns to
    // "saved" by itself in a moment
    return { ok: false, ending: true }
  }
  // asked once now, to learn whether Chrome allows it at all
  try {
    await askHandle(tabId)
  } catch (err) {
    const m = String((err && err.message) || err)
    if (/invoked|activeTab|not been|permission/i.test(m)) {
      want(tabId, mode, spaceId)
      setCard(tabId, { state: 'needIcon', mode, key: await shortcut() })
      return { ok: false, needIcon: true }
    }
    setCard(tabId, { state: 'failed', error: 'The meeting tab could not be captured: ' + m })
    return { ok: false, error: m }
  }
  want(tabId, null)
  clearEngineClose()
  setCard(tabId, { state: 'starting', mode, url: tab.url || '', error: undefined, sessionId: undefined, hostUrl: undefined, qr: undefined, lastLine: undefined })
  try {
    return await startWithEngine(tab, mode, spaceId)
  } catch (err) {
    setCard(tabId, { state: 'failed', error: 'Sitca could not start: ' + String((err && err.message) || err) })
    return { ok: false }
  }
}

async function startWithEngine(tab, mode, spaceId) {
  const tabId = tab.id
  const e = await ensureEngine()
  if (!e.ready) {
    setCard(tabId, { state: 'failed', error: 'Sitca could not start. Reload the page and try again.' })
    return { ok: false }
  }
  if (!e.signedIn) {
    // Nobody is signed in on this browser yet: Sitca opens in a tab to sign
    // in. What was asked is remembered; the moment the sign-in lands, the
    // person is brought back to the call and it starts by itself.
    signinFor = { tabId, mode, spaceId: spaceId || '', at: Date.now() }
    setCard(tabId, { state: 'signin' })
    const t = await chrome.tabs.create({ url: APP + '#signin', active: true })
    signinFor.appTab = t.id
    remember()
    await closeEngineIfIdle()
    return { ok: false, signin: true }
  }
  // and once more now the engine is awake: the handle is used the moment it arrives
  let streamId
  try {
    streamId = await askHandle(tabId)
  } catch (err) {
    setCard(tabId, { state: 'failed', error: 'The meeting tab could not be captured: ' + String((err && err.message) || err) })
    return { ok: false }
  }
  if (cardOf(tabId).state !== 'starting') {
    // Stop was pressed while the engine was waking: nothing starts
    return { ok: false, cancelled: true }
  }
  const req = { tabId, title: tab.title || '', url: tab.url || '', at: Date.now(), mode, streamId, spaceId: spaceId || undefined }
  chrome.runtime.sendMessage({ type: 'sitca:engine:start', ...req }).catch(() => undefined)
  return { ok: true }
}

function stopCapture(tabId) {
  const c = cardOf(tabId)
  if (c.state !== 'recording' && c.state !== 'starting') return
  if (c.state === 'starting') {
    // nothing is recording yet: the start is called off (the engine, if it
    // was already told to begin, lets go) and the card is free
    chrome.runtime.sendMessage({ type: 'sitca:engine:stop', tabId }).catch(() => undefined)
    cards.delete(tabId)
    want(tabId, null)
    chrome.tabs.sendMessage(tabId, { type: 'sitca:card', card: { state: 'idle', tabId } }).catch(() => undefined)
    scheduleEngineClose()
    return
  }
  setCard(tabId, { state: 'ending' })
  chrome.runtime.sendMessage({ type: 'sitca:engine:stop', tabId }).catch(() => undefined)
}

/**
 * Sitca in a tab, on this session; an open Sitca tab is reused. A session
 * still being captured opens in the extension's own page, which hears the
 * engine as it writes; a finished one opens on the website.
 */
async function openViewer(sessionId, finished) {
  const base = finished ? SITE : APP
  // a stamp on the end, so opening the same session twice still counts as a change of address
  const url = sessionId ? `${base}#open=${sessionId}&t=${Date.now()}` : base
  const tabs = await chrome.tabs.query({ url: base + '*' }).catch(() => [])
  const mine = tabs.find((t) => t.id !== undefined)
  if (mine) {
    await chrome.tabs.update(mine.id, { url, active: true }).catch(() => undefined)
    if (mine.windowId !== undefined) chrome.windows.update(mine.windowId, { focused: true }).catch(() => undefined)
    return
  }
  await chrome.tabs.create({ url, active: true })
}

// ---------- the presses Chrome counts ----------

/**
 * The icon, the menu, the shortcut: the presses that invite the extension
 * in. On a meeting tab the card takes it from here; anywhere else the side
 * panel opens (in the same instant, as Chrome demands).
 */
function invited(tab) {
  if (!tab || !tab.id) return
  const meeting = Boolean(tab.url && MEETING.test(tab.url))
  if (!meeting) {
    chrome.sidePanel.open({ tabId: tab.id }).catch(() => undefined)
    return
  }
  const c = cardOf(tab.id)
  if (c.state === 'recording' || c.state === 'starting') {
    void openViewer(c.sessionId)
    return
  }
  const w = wanted.get(tab.id)
  if (w) {
    void startCapture(tab, typeof w === 'string' ? w : w.mode, typeof w === 'string' ? '' : w.spaceId)
    return
  }
  // nothing chosen yet: the card unfolds its two choices, and from now on
  // Chrome allows the capture on this tab, so the card's own press will do
  setCard(tab.id, { state: 'choose', allowed: true })
}

chrome.action.onClicked.addListener((tab) => {
  // the panel must open in the same instant as the press: that path first
  if (!tab || !tab.url || !MEETING.test(tab.url)) {
    if (tab && tab.id) chrome.sidePanel.open({ tabId: tab.id }).catch(() => undefined)
    return
  }
  void remembered.then(() => invited(tab))
})
function pressed(tab) {
  if (!tab || !tab.id) return
  // the panel must open in the same instant as the press: that path first
  if (!tab.url || !MEETING.test(tab.url)) {
    chrome.sidePanel.open({ tabId: tab.id }).catch(() => undefined)
    return
  }
  void remembered.then(() => invited(tab))
}
chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === 'sitca-capture') pressed(tab)
})
chrome.commands.onCommand.addListener((command, tab) => {
  if (command === 'capture') pressed(tab)
})

// ---------- messages ----------

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (!msg || typeof msg !== 'object' || typeof msg.type !== 'string') return undefined
  void remembered.then(() => handle(msg, sender, reply))
  return true // every answer comes once the memory is loaded
})

function handle(msg, sender, reply) {
  const tab = sender.tab
  const tabId = tab && tab.id

  // ----- from the card -----
  if (msg.type === 'sitca:card:state') {
    const c = cardOf(tabId)
    if (c.state === 'recording' || c.state === 'starting' || c.state === 'ending') {
      // a card remembered as running, but is the engine still there? (Chrome
      // may have been closed and opened again)
      pingEngine().then((alive) => {
        if (alive) reply(c)
        else {
          cards.delete(tabId)
          want(tabId, null)
          remember()
          reply({ state: 'idle' })
        }
      })
      return true
    }
    reply(c)
    return undefined
  }
  // ----- from the viewer: back to the call -----
  // ----- the person signed in, in the tab the card opened -----
  if (msg.type === 'sitca:signedin') {
    engine.signedIn = true
    const want = signinFor
    signinFor = null
    remember()
    const appTab = sender.tab ? sender.tab.id : want && want.appTab
    ;(async () => {
      if (want && Date.now() - want.at < 30 * 60000) {
        let tab = null
        try {
          tab = await chrome.tabs.get(want.tabId)
        } catch {
          tab = null
        }
        if (tab) {
          await chrome.tabs.update(tab.id, { active: true }).catch(() => undefined)
          if (tab.windowId !== undefined) chrome.windows.update(tab.windowId, { focused: true }).catch(() => undefined)
          setCard(tab.id, { state: 'starting', mode: want.mode })
          // the press on the icon that began this still stands for the tab;
          // should Chrome want a fresh one, the card asks for it
          startCapture(tab, want.mode, want.spaceId).catch(() => setCard(tab.id, { state: 'needIcon' }))
        }
      }
      // the sign-in tab has done its work
      if (typeof appTab === 'number') setTimeout(() => chrome.tabs.remove(appTab).catch(() => undefined), 1200)
    })()
    reply({ ok: true })
    return undefined
  }
  // the card's own "Sign in" press: the sign-in tab, brought forward or opened
  if (msg.type === 'sitca:card:signin') {
    ;(async () => {
      if (signinFor && typeof signinFor.appTab === 'number') {
        try {
          await chrome.tabs.update(signinFor.appTab, { active: true })
          reply({ ok: true })
          return
        } catch {
          /* closed: opened again below */
        }
      }
      const t = await chrome.tabs.create({ url: APP + '#signin', active: true })
      if (signinFor) signinFor.appTab = t.id
      else if (tab) signinFor = { tabId: tab.id, mode: 'record', spaceId: '', at: Date.now(), appTab: t.id }
      reply({ ok: true })
    })()
    return true
  }
  if (msg.type === 'sitca:focus-meeting') {
    const t = recordingTab()
    if (t !== null) {
      chrome.tabs.update(t, { active: true }).then(
        (tt) => {
          if (tt && tt.windowId !== undefined) chrome.windows.update(tt.windowId, { focused: true }).catch(() => undefined)
          reply({ ok: true })
        },
        () => reply({ ok: false })
      )
      return true
    }
    reply({ ok: false })
    return undefined
  }
  if (msg.type === 'sitca:card:start') {
    if (!tab) {
      reply({ ok: false })
      return undefined
    }
    startCapture(tab, msg.mode === 'host' ? 'host' : 'record', typeof msg.spaceId === 'string' ? msg.spaceId : '').then(reply, () => reply({ ok: false }))
    return true
  }
  if (msg.type === 'sitca:card:courses') {
    // The courses this person teaches, as the extension's pages last
    // reported them. Nothing known yet (a fresh install, a new course): the
    // engine is woken, and it reports on arrival; the card waits a moment.
    chrome.storage.local.get('courses').then(
      async (s) => {
        const known = Array.isArray(s.courses) ? s.courses : []
        if (known.length > 0 || coursesAsked) return reply({ courses: known })
        coursesAsked = true
        const fresh = await new Promise((resolve) => {
          coursesWaiters.push(resolve)
          setTimeout(() => resolve(null), 12000)
          ensureEngine().catch(() => undefined)
        })
        // woken only to answer this: it goes again in a minute unless a session starts
        if (recordingTab() === null) scheduleEngineClose()
        reply({ courses: Array.isArray(fresh) ? fresh : known })
      },
      () => reply({ courses: [] })
    )
    return true
  }
  if (msg.type === 'sitca:courses') {
    const list = Array.isArray(msg.courses) ? msg.courses.slice(0, 50) : []
    chrome.storage.local.set({ courses: list }).catch(() => undefined)
    coursesWaiters.splice(0).forEach((r) => r(list))
    reply({ ok: true })
    return undefined
  }
  if (msg.type === 'sitca:card:stop' || msg.type === 'sitca:card:left') {
    // Stop pressed, or the person left the call: either way the session ends
    if (tabId !== undefined) stopCapture(tabId)
    reply({ ok: true })
    return undefined
  }
  if (msg.type === 'sitca:card:still') {
    chrome.runtime.sendMessage({ type: 'sitca:engine:still' }).catch(() => undefined)
    reply({ ok: true })
    return undefined
  }
  if (msg.type === 'sitca:card:mic') {
    chrome.runtime.sendMessage({ type: 'sitca:engine:mic', on: msg.on }).catch(() => undefined)
    reply({ ok: true })
    return undefined
  }
  if (msg.type === 'sitca:card:open') {
    const c = cardOf(tabId)
    const finished = c.state === 'ended' || c.state === 'ending'
    openViewer(c.sessionId, finished).then(() => reply({ ok: true }), () => reply({ ok: false }))
    return true
  }
  if (msg.type === 'sitca:card:reset') {
    cards.delete(tabId)
    want(tabId, null)
    reply({ ok: true })
    return undefined
  }
  if (msg.type === 'sitca:card:ask') {
    const c = cardOf(tabId)
    if (!c.sessionId) {
      reply({ answer: 'Start capturing first, then ask.' })
      return undefined
    }
    chrome.runtime
      .sendMessage({ type: 'sitca:engine:ask', sessionId: c.sessionId, text: String(msg.text || '') })
      .then((r) => reply(r || { answer: '' }), () => reply({ answer: 'Sitca could not answer just now.' }))
    return true
  }
  if (msg.type === 'sitca:caption') {
    const c = cardOf(tabId)
    if (c.state === 'recording') {
      chrome.runtime.sendMessage({ type: 'sitca:engine:caption', who: msg.who, text: msg.text, at: msg.at, end: msg.end }).catch(() => undefined)
    }
    reply({ ok: true })
    return undefined
  }

  // ----- from the engine -----
  if (msg.type === 'sitca:engine:ready') {
    engine.ready = true
    engine.signedIn = Boolean(msg.signedIn)
    const w = engine.waiting.splice(0)
    w.forEach((r) => r())
    reply({ ok: true })
    return undefined
  }
  if (msg.type === 'sitca:engine:status') {
    const t = msg.tabId
    if (typeof t !== 'number' || !cards.has(t)) {
      // a tab already closed, or a start already called off: nothing to show it to
      if (msg.state === 'ended' || msg.state === 'failed') scheduleEngineClose()
      reply({ ok: true })
      return undefined
    }
    if (msg.state === 'recording') {
      const patch = { state: 'recording', sessionId: msg.sessionId, startedAt: msg.startedAt }
      if (msg.title) patch.title = msg.title
      if (msg.hostUrl) patch.hostUrl = msg.hostUrl
      if (msg.qr) patch.qr = msg.qr
      if (msg.lastLine) patch.lastLine = msg.lastLine
      if (typeof msg.mic === 'boolean') patch.mic = msg.mic
      if (msg.talkingMuted) {
        // a moment, not a state: told to the card once and not remembered
        chrome.tabs.sendMessage(t, { type: 'sitca:nudge', what: 'mic' }).catch(() => undefined)
      }
      if (msg.stillAsk) {
        // "still there?": asked on the card, and taken back once answered
        chrome.tabs.sendMessage(t, { type: 'sitca:nudge', what: 'still', why: msg.stillAsk }).catch(() => undefined)
      }
      setCard(t, patch)
    } else if (msg.state === 'ending') {
      const patch = { state: 'ending' }
      if (msg.recapUrl) patch.recapUrl = msg.recapUrl
      setCard(t, patch)
    } else if (msg.state === 'ended') {
      const patch = { state: 'ended', sessionId: msg.sessionId || cardOf(t).sessionId }
      if (msg.recapUrl) patch.recapUrl = msg.recapUrl
      setCard(t, patch)
      want(t, null)
      scheduleEngineClose()
    } else if (msg.state === 'failed') {
      setCard(t, { state: 'failed', error: msg.error || 'Sitca could not start.' })
      scheduleEngineClose()
    } else if (msg.state === 'starting') {
      if (cardOf(t).state !== 'recording') setCard(t, { state: 'starting' })
    }
    reply({ ok: true })
    return undefined
  }
  if (msg.type === 'sitca:mic:ask') {
    chrome.tabs.create({ url: chrome.runtime.getURL('mic.html'), active: true }).catch(() => undefined)
    reply({ ok: true })
    return undefined
  }
  if (msg.type === 'sitca:mic') {
    // the answer travels on to the engine (every extension page hears it)
    reply({ ok: true })
    return undefined
  }

  // ----- from the side panel (kept for those who use it) -----
  if (msg.type === 'sitca:pending') {
    reply(null)
    return undefined
  }
  if (msg.type === 'sitca:done') {
    reply({ ok: true })
    return undefined
  }
  reply(undefined)
  return undefined
}

// ---------- the meeting tab itself ----------

// leaving the call, or the page, ends the session: the tab was the source
chrome.tabs.onRemoved.addListener((tabId) => {
  void remembered.then(() => {
    const c = cardOf(tabId)
    if (c.state === 'recording' || c.state === 'starting') stopCapture(tabId)
    cards.delete(tabId)
    want(tabId, null)
  })
})
/** the site a page belongs to: youtube.com for www. and m. alike, and so on */
function siteOf(url) {
  try {
    return new URL(url).hostname.replace(/^(www|m)\./, '')
  } catch {
    return ''
  }
}
chrome.tabs.onUpdated.addListener((tabId, change) => {
  if (!change.url) return
  void remembered.then(() => {
    const c = cardOf(tabId)
    if (c.state !== 'recording' && c.state !== 'starting') return
    // Moving about within the site is not leaving it: YouTube's small player
    // carries a video onto the home page, Meet stays on its address after a
    // call. The capture follows the tab wherever the tab goes on that site;
    // only another site altogether ends it.
    const was = siteOf(c.url || '')
    const now = siteOf(change.url)
    if (was && now && was !== now) stopCapture(tabId)
  })
})
