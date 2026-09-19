// Sitca on the meeting page.
//
// A small card in the corner of a Google Meet or Zoom call. It never
// records anything itself: it asks the extension's worker, shows what the
// worker says back, and, on Google Meet, reads the call's own captions off
// the page so the transcript carries each speaker's name as it happens.
//
// While a session runs, the card lives in a little window of its own that
// floats above everything (Chrome's picture-in-picture for documents). Two
// reasons. It is not part of the page, so the recording never shows it: a
// recap can be shared without the person's questions to Sitca in the video.
// And it stays on top while the person moves between windows, and can be
// pulled larger by its corner, so the conversation has room.
//
// States, in the order a person meets them:
//   idle       one button: Capture with Sitca
//   choose     just record, or host on Sitca with a link for the room
//   needIcon   Chrome wants one press on the toolbar icon first (once per tab)
//   starting   a moment while the engine wakes
//   recording  the companion: timer, the latest words, the conversation, Stop
//   ending     saving; the recap link is already there to copy
//   ended      saved, with the link
;(() => {
  if (window.top !== window.self) return
  if (document.getElementById('sitca-card')) return
  const MEETING = /^https:\/\/(meet\.google\.com\/[a-z]{3}-[a-z]{4}-[a-z]{3}|[a-z0-9.-]*zoom\.us\/(wc|j)\/)/
  const IS_MEET = location.hostname === 'meet.google.com'
  const CAN_FLOAT = 'documentPictureInPicture' in window

  const MARK =
    '<svg class="sc-mark" viewBox="0 0 64 64" aria-hidden="true"><circle cx="32" cy="32" r="22" fill="none" stroke="currentColor" stroke-width="7"/><circle cx="52" cy="22" r="6" fill="currentColor"/></svg>'

  const root = document.createElement('div')
  root.id = 'sitca-card'
  root.setAttribute('data-state', 'idle')
  let card = { state: 'idle' }
  let chat = [] // { role: 'you' | 'sitca', text }
  let asking = false
  let showQr = false
  let tick = null
  let pip = null // the floating window, while open
  let showCc = false // Meet's captions on the screen itself; Sitca reads them either way

  // ---------- talking to the worker ----------

  function ask(msg) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(msg, (reply) => {
          void chrome.runtime.lastError
          resolve(reply)
        })
      } catch {
        resolve(undefined)
      }
    })
  }

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg && msg.type === 'sitca:card' && msg.card) {
      const was = card.state
      card = msg.card
      if (card.state !== 'recording') showQr = false
      if (card.state === 'idle' || card.state === 'choose' || card.state === 'starting') chat = []
      render()
      if (card.state === 'recording' && was !== 'recording') {
        captionsOn()
        watchCall()
      }
      if (card.state !== 'recording' && was === 'recording') {
        captionsOff()
        unwatchCall()
      }
    }
  })

  // ---------- the floating window ----------

  async function float() {
    if (!CAN_FLOAT || pip) return
    try {
      const w = await window.documentPictureInPicture.requestWindow({ width: 380, height: 470 })
      pip = w
      const link = w.document.createElement('link')
      link.rel = 'stylesheet'
      link.href = chrome.runtime.getURL('meet.css')
      w.document.head.appendChild(link)
      w.document.title = 'Sitca'
      w.document.documentElement.style.cssText = 'overflow:hidden;height:100%;background:#131315'
      w.document.body.style.cssText = 'margin:0;height:100%;overflow:hidden;background:#131315'
      root.classList.add('sc-float')
      w.document.body.appendChild(root)
      w.addEventListener('pagehide', () => {
        // closed by the person: the card comes home to the page
        pip = null
        root.classList.remove('sc-float')
        if (!document.body.contains(root)) document.body.appendChild(root)
        render()
      })
      render()
    } catch {
      pip = null
    }
  }
  function unfloat() {
    if (pip) {
      try {
        pip.close()
      } catch {
        /* ignore */
      }
    }
  }

  // ---------- the card ----------

  function esc(s) {
    return String(s || '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c])
  }
  function plain(s) {
    // an answer arrives with a little markdown and [[M:SS]] moments; here it is read as words
    return String(s || '')
      .replace(/\*\*(.+?)\*\*/g, '$1')
      .replace(/\[\[(\d+:\d{2}(?::\d{2})?)\]\]/g, '(at $1)')
      .replace(/^#+\s*/gm, '')
      .replace(/^\s*[-*]\s+/gm, '• ')
      .trim()
  }
  function clock(startedAt) {
    const s = Math.max(0, Math.floor((Date.now() - (startedAt || Date.now())) / 1000))
    const h = Math.floor(s / 3600)
    const m = Math.floor((s % 3600) / 60)
    const sec = s % 60
    return (h ? h + ':' : '') + String(m).padStart(h ? 2 : 1, '0') + ':' + String(sec).padStart(2, '0')
  }
  function shortUrl(u) {
    return String(u || '')
      .replace(/^https?:\/\//, '')
      .replace(/\/$/, '')
  }

  function linkRow(url, label) {
    return `<div class="sc-link" title="${esc(url)}">
      <span class="sc-link-l">${label}</span>
      <span class="sc-link-url">${esc(shortUrl(url))}</span>
      <button type="button" class="sc-mini" data-act="copy" data-url="${esc(url)}">Copy</button>
    </div>`
  }

  function render() {
    const st = card.state
    root.setAttribute('data-state', st)
    let html = ''
    if (st === 'idle') {
      html = `<button type="button" class="sc-pill" data-act="choose">${MARK}<span>Capture with Sitca</span></button>`
    } else if (st === 'choose' || st === 'needIcon' || st === 'signin' || st === 'busy' || st === 'failed') {
      html = `<div class="sc-box">
        <div class="sc-head">${MARK}<b>Sitca</b><button type="button" class="sc-x" data-act="close" aria-label="Close">×</button></div>`
      if (st === 'choose') {
        html += `<div class="sc-title">Capture this meeting</div>
        <button type="button" class="sc-opt" data-act="start" data-mode="record">
          <span class="sc-opt-t">Just record</span>
          <span class="sc-opt-d">Recording, live captions, notes and a recap, for you.</span>
        </button>
        <button type="button" class="sc-opt" data-act="start" data-mode="host">
          <span class="sc-opt-t">Host on Sitca</span>
          <span class="sc-opt-d">The same, plus a link so people in the room follow along and ask.</span>
        </button>`
      } else if (st === 'needIcon') {
        html += `<div class="sc-title">One more press</div>
        <p class="sc-p">Press the <b>Sitca icon</b> in Chrome’s toolbar, top right. Chrome asks for that once, and then this card does the rest.</p>
        <div class="sc-arrow" aria-hidden="true">↗</div>`
      } else if (st === 'signin') {
        html += `<div class="sc-title">Sign in first</div>
        <p class="sc-p">Sitca opened in a new tab. Sign in there, come back, and press the button again.</p>
        <button type="button" class="sc-btn" data-act="choose">Try again</button>`
      } else if (st === 'busy') {
        html += `<div class="sc-title">Already capturing</div>
        <p class="sc-p">Sitca is recording another tab. Stop it there first.</p>`
      } else if (st === 'failed') {
        html += `<div class="sc-title">Could not start</div>
        <p class="sc-p">${esc(card.error || 'Something went wrong.')}</p>
        <button type="button" class="sc-btn" data-act="choose">Try again</button>`
      }
      html += '</div>'
    } else if (st === 'starting') {
      html = `<div class="sc-bar"><span class="sc-spin"></span><span class="sc-bar-text">Starting Sitca…</span></div>`
    } else if (st === 'recording' && !pip) {
      // On the page itself, while recording, only a slim bar: the page is
      // what is being recorded, and the conversation must never be in it.
      // The conversation lives in the floating window or the Sitca tab.
      const live = card.mode === 'host' || Boolean(card.hostUrl)
      html = `<div class="sc-bar sc-slim">
        <span class="sc-dot"></span>
        <span class="sc-time" data-clock>${clock(card.startedAt)}</span>
        <span class="sc-label">${live ? 'Live on Sitca' : 'Recording'}</span>
        ${CAN_FLOAT ? '<button type="button" class="sc-mini" data-act="float" title="Chat with Sitca privately, in a window the recording never sees">Chat</button>' : ''}
        <button type="button" class="sc-mini" data-act="open" title="Open this session in Sitca">Open</button>
        <button type="button" class="sc-mini sc-stop" data-act="stop">Stop</button>
      </div>`
    } else if (st === 'recording') {
      const live = card.mode === 'host' || Boolean(card.hostUrl)
      html = `<div class="sc-panel">
        <div class="sc-row sc-top">
          <span class="sc-dot"></span>
          <span class="sc-time" data-clock>${clock(card.startedAt)}</span>
          <span class="sc-label">${live ? 'Live on Sitca' : 'Recording'}</span>
          <button type="button" class="sc-mini" data-act="open" title="Open this session in Sitca">Open</button>
          <button type="button" class="sc-mini sc-stop" data-act="stop">Stop</button>
        </div>`
      if (card.hostUrl) {
        html += linkRow(card.hostUrl, 'Room')
        if (card.qr) {
          html += `<button type="button" class="sc-qr-toggle" data-act="qr">${showQr ? 'Hide the QR code' : 'Show a QR code for the room'}</button>`
          if (showQr) html += `<img class="sc-qr" src="${card.qr}" alt="QR code for the link">`
        }
      }
      html += `<div class="sc-chat" data-chat>`
      if (chat.length === 0) {
        html += `<div class="sc-hello">
          <div class="sc-hello-t">Sitca is listening.</div>
          <div class="sc-hello-d">Ask anything about what has been said, privately. Nobody in the call sees this.</div>
        </div>`
      }
      for (const m of chat) {
        html += `<div class="sc-msg sc-${m.role}">${esc(m.text)}</div>`
      }
      if (asking) html += `<div class="sc-msg sc-sitca sc-thinking"><span class="sc-dots"><span></span><span></span><span></span></span></div>`
      html += `</div>
        <div class="sc-foot">
          <div class="sc-last" title="${esc(card.lastLine || '')}">${esc(card.lastLine || 'Listening…')}</div>
          ${IS_MEET ? `<button type="button" class="sc-cc" data-act="cc" title="Meet's captions on the screen. Sitca reads them either way.">Captions on screen <b>${showCc ? 'on' : 'off'}</b></button>` : ''}
        </div>
        <form class="sc-ask" data-act="ask">
          <input type="text" class="sc-in" placeholder="Ask about what was said…" maxlength="400" ${asking ? 'disabled' : ''}>
          <button type="submit" class="sc-go" ${asking ? 'disabled' : ''} aria-label="Ask">↑</button>
        </form>
      </div>`
    } else if (st === 'ending' || st === 'ended') {
      const saved = st === 'ended'
      html = `<div class="sc-box sc-done">
        <div class="sc-head">${MARK}<b>Sitca</b>${saved ? '<button type="button" class="sc-x" data-act="close" aria-label="Close">×</button>' : ''}</div>
        <div class="sc-row">
          ${saved ? '<span class="sc-ok">✓</span>' : '<span class="sc-spin"></span>'}
          <span class="sc-title sc-title-inline">${saved ? 'Saved to your library' : 'Saving…'}</span>
        </div>`
      if (card.recapUrl) {
        // the link leads: a lecturer pastes it to the class and is done
        html += `<div class="sc-share">
          <div class="sc-share-t">Share the recap</div>
          <div class="sc-share-url" title="${esc(card.recapUrl)}">${esc(shortUrl(card.recapUrl))}</div>
          <button type="button" class="sc-btn sc-btn-wide" data-act="copy" data-url="${esc(card.recapUrl)}">Copy the link</button>
          <div class="sc-share-d">Anyone with it can watch, read the notes and ask Sitca.</div>
        </div>`
      } else if (!saved) {
        html += `<p class="sc-p sc-p-tight">The recap link appears here in a moment.</p>`
      } else {
        html += `<p class="sc-p sc-p-tight">No recap link: nothing was said in this session.</p>`
      }
      html += `<div class="sc-actions">
          <button type="button" class="sc-mini sc-mini-lg" data-act="open">Open in Sitca</button>
          ${saved ? '<button type="button" class="sc-mini sc-mini-lg" data-act="again">Capture again</button>' : ''}
        </div>
      </div>`
    }
    // the question being typed survives a re-render (the timer, a new line heard)
    const typed = root.querySelector('.sc-in')
    const keep = typed ? typed.value : ''
    const focused = typed && root.ownerDocument.activeElement === typed
    root.innerHTML = html
    const input = root.querySelector('.sc-in')
    if (input && keep) input.value = keep
    if (input && focused) input.focus()
    const chatEl = root.querySelector('[data-chat]')
    if (chatEl) chatEl.scrollTop = chatEl.scrollHeight
    if (tick) clearInterval(tick)
    tick = null
    if (st === 'recording') {
      tick = setInterval(() => {
        const t = root.querySelector('[data-clock]')
        if (t) t.textContent = clock(card.startedAt)
      }, 1000)
    }
  }

  root.addEventListener('click', (e) => {
    const b = e.target.closest('[data-act]')
    if (!b || b.tagName === 'FORM') return
    const act = b.getAttribute('data-act')
    if (act === 'choose') {
      card = { ...card, state: 'choose' }
      render()
    } else if (act === 'close') {
      const back = ['ended', 'failed', 'needIcon', 'signin', 'busy'].includes(card.state)
      card = { state: 'idle' }
      chat = []
      unfloat()
      if (back) void ask({ type: 'sitca:card:reset' })
      render()
    } else if (act === 'start') {
      const mode = b.getAttribute('data-mode') === 'host' ? 'host' : 'record'
      card = { ...card, state: 'starting', mode }
      // this press is the one chance to open the floating window: Chrome
      // only opens it on a press, and the next presses may be on the icon
      void float()
      render()
      void ask({ type: 'sitca:card:start', mode }).then((r) => {
        if (r && r.ok) return
        if (!r) {
          card = { state: 'failed', error: 'Sitca did not answer. Reload the page and try again.' }
          render()
        }
        // otherwise the worker has already set the card to what it needs
      })
    } else if (act === 'stop') {
      void ask({ type: 'sitca:card:stop' })
      card = { ...card, state: 'ending' }
      render()
    } else if (act === 'open') {
      void ask({ type: 'sitca:card:open' })
    } else if (act === 'again') {
      void ask({ type: 'sitca:card:reset' })
      card = { state: 'choose' }
      chat = []
      render()
    } else if (act === 'copy') {
      const url = b.getAttribute('data-url') || ''
      if (url) {
        const was = b.textContent
        navigator.clipboard.writeText(url).then(
          () => {
            b.textContent = 'Copied ✓'
            setTimeout(() => (b.textContent = was), 1800)
          },
          () => undefined
        )
      }
    } else if (act === 'qr') {
      showQr = !showQr
      render()
    } else if (act === 'float') {
      void float()
    } else if (act === 'cc') {
      showCc = !showCc
      hideCaptions(!showCc)
      render()
    }
  })
  root.addEventListener('submit', (e) => {
    const f = e.target.closest('form[data-act="ask"]')
    if (!f) return
    e.preventDefault()
    const input = f.querySelector('.sc-in')
    const text = (input && input.value.trim()) || ''
    if (!text || asking) return
    asking = true
    chat.push({ role: 'you', text })
    if (input) input.value = ''
    render()
    void ask({ type: 'sitca:card:ask', text }).then((r) => {
      asking = false
      chat.push({ role: 'sitca', text: plain((r && r.answer) || 'Sitca could not answer just now.') })
      if (chat.length > 40) chat = chat.slice(-40)
      render()
    })
  })
  // keys typed into the card must not reach Meet's own shortcuts (c, d, e…)
  root.addEventListener('keydown', (e) => e.stopPropagation())
  root.addEventListener('keyup', (e) => e.stopPropagation())
  root.addEventListener('keypress', (e) => e.stopPropagation())

  // ---------- the call itself ----------
  // Leaving the call is the end of the session: Meet keeps the same address
  // after "You left the meeting", so the controls are watched instead.

  let callTimer = null
  let goneFor = 0
  let wasInCall = false
  function inCall() {
    if (!IS_MEET) return true
    return Boolean(document.querySelector('[aria-label*="leave call" i], [aria-label*="Leave call" i], [data-tooltip*="Leave call" i]'))
  }
  function leftScreen() {
    // the page Meet shows after leaving: same address, different words
    const t = document.body ? document.body.innerText || '' : ''
    return /you left the meeting|you've left the meeting|return to home screen|rejoin/i.test(t.slice(0, 4000))
  }
  function watchCall() {
    if (callTimer) return
    goneFor = 0
    wasInCall = inCall()
    callTimer = setInterval(() => {
      if (inCall()) {
        wasInCall = true
        goneFor = 0
        return
      }
      // before joining (the lobby) there is no Leave button either: only a
      // call that was joined, and is now gone, counts as left
      if (!wasInCall && !leftScreen()) return
      goneFor++
      if (goneFor >= 3) {
        unwatchCall()
        void ask({ type: 'sitca:card:left' })
        card = { ...card, state: 'ending' }
        render()
      }
    }, 2000)
  }
  function unwatchCall() {
    if (callTimer) clearInterval(callTimer)
    callTimer = null
  }

  // ---------- Google Meet's own captions ----------
  // Meet writes the words on the page as they are spoken, each with the
  // speaker's name. Read there, they reach the session as a transcript that
  // already knows who said what. The page's layout is Google's and changes
  // now and then: the reader looks for shapes, not names of things, and when
  // it finds nothing the recording's own captions carry on instead.

  let capTimer = null
  let current = null // { who, text, at, sentLen, changedAt }

  function captionsButton() {
    const btns = document.querySelectorAll('button[aria-label], [role="button"][aria-label]')
    for (const b of btns) {
      const l = (b.getAttribute('aria-label') || '').toLowerCase()
      if (/caption|subtitle/.test(l) && !/setting|language/.test(l)) return b
    }
    return null
  }
  function turnCaptionsOn() {
    const b = captionsButton()
    if (!b) return false
    const l = (b.getAttribute('aria-label') || '').toLowerCase()
    const pressed = b.getAttribute('aria-pressed')
    const on = pressed === 'true' || /turn off|hide/.test(l)
    if (!on) b.click()
    return true
  }

  function captionsRegion() {
    return document.querySelector('[role="region"][aria-label*="aption" i], [aria-label="Captions"]')
  }

  // Meet's captions stay switched on for Sitca to read, but are kept off the
  // screen: the block Meet draws them in (the language chip, the font
  // controls, and the lines themselves) takes a good third of the picture
  // and pushes everyone's tiles up. The whole block is folded to nothing;
  // the words still arrive in it, only nothing of it is drawn or measured.
  const HIDE_ID = 'sitca-hide-captions'
  const FOLDED = 'data-sitca-folded'
  const FOLD = ['height', 'min-height', 'max-height', 'overflow', 'opacity', 'pointer-events', 'margin', 'padding']
  function captionBlock() {
    const region = captionsRegion()
    if (!region) return null
    // up from the words to the top of Meet's caption block: the last
    // ancestor that holds no video tile
    let el = region
    while (el.parentElement && el.parentElement !== document.body && !el.parentElement.querySelector('video')) {
      el = el.parentElement
    }
    return el
  }
  function foldCaptions() {
    const block = captionBlock()
    if (!block || block.getAttribute(FOLDED) === '1') return
    block.setAttribute(FOLDED, '1')
    block.style.setProperty('height', '0', 'important')
    block.style.setProperty('min-height', '0', 'important')
    block.style.setProperty('max-height', '0', 'important')
    block.style.setProperty('overflow', 'hidden', 'important')
    block.style.setProperty('opacity', '0', 'important')
    block.style.setProperty('pointer-events', 'none', 'important')
    block.style.setProperty('margin', '0', 'important')
    block.style.setProperty('padding', '0', 'important')
  }
  function unfoldCaptions() {
    for (const el of document.querySelectorAll(`[${FOLDED}]`)) {
      el.removeAttribute(FOLDED)
      for (const prop of FOLD) el.style.removeProperty(prop)
    }
  }
  function hideCaptions(hide) {
    let st = document.getElementById(HIDE_ID)
    if (!hide) {
      if (st) st.remove()
      unfoldCaptions()
      return
    }
    if (!st) {
      st = document.createElement('style')
      st.id = HIDE_ID
      // the words themselves, in case the block is drawn again before the next fold
      st.textContent = '[role="region"][aria-label*="aption" i],[aria-label="Captions"]{opacity:0!important;pointer-events:none!important}'
      document.documentElement.appendChild(st)
    }
    foldCaptions()
  }

  const NOT_A_ROW = /jump to|arrow_downward|^\.{2,}$|продолжение/i
  /** a row is a speaker and their words: a picture plus text, or at least a name and text */
  function captionRows(region) {
    const out = []
    for (const el of region.children) {
      if (el.querySelector('button, [role="button"]')) continue
      const t = (el.textContent || '').trim()
      if (t.length < 2 || NOT_A_ROW.test(t)) continue
      let leaves = 0
      for (const n of el.querySelectorAll('*')) if (n.children.length === 0 && (n.textContent || '').trim()) leaves++
      if (!el.querySelector('img') && leaves < 2) continue
      out.push(el)
    }
    return out
  }

  function readLastRow(region) {
    const rows = captionRows(region)
    if (rows.length === 0) return null
    const row = rows[rows.length - 1]
    const leaves = []
    const walk = (el) => {
      for (const c of el.children) {
        if (c.tagName === 'IMG' || c.tagName === 'SVG' || c.tagName === 'BUTTON') continue
        if (c.children.length === 0) {
          const t = (c.textContent || '').trim()
          if (t) leaves.push(t)
        } else walk(c)
      }
    }
    walk(row)
    if (leaves.length === 0) return null
    let who = ''
    let text = ''
    if (leaves.length >= 2 && leaves[0].length <= 40 && !/[.!?]$/.test(leaves[0])) {
      who = leaves[0]
      text = leaves.slice(1).join(' ')
    } else text = leaves.join(' ')
    text = text.replace(/\s+/g, ' ').trim()
    if (!text || NOT_A_ROW.test(text)) return null
    return { who, text }
  }

  function send(who, text, at) {
    const clean = text.trim()
    if (clean.length < 2) return
    void ask({ type: 'sitca:caption', who, text: clean, at, end: Date.now() })
  }

  function pollCaptions() {
    const region = captionsRegion()
    if (!region) return
    const last = readLastRow(region)
    const now = Date.now()
    if (!last) {
      if (current && current.text.length > current.sentLen) {
        send(current.who, current.text.slice(current.sentLen), current.at)
        current.sentLen = current.text.length
      }
      return
    }
    const sameRow = current && current.who === last.who && last.text.startsWith(current.text.slice(0, Math.min(current.text.length, current.sentLen || 12)))
    if (!sameRow) {
      if (current && current.text.length > current.sentLen) send(current.who, current.text.slice(current.sentLen), current.at)
      current = { who: last.who, text: last.text, at: now, sentLen: 0, changedAt: now }
      return
    }
    if (last.text !== current.text) {
      current.text = last.text
      current.changedAt = now
    }
    // words that have held still for a moment are final enough to keep; a
    // row that keeps growing is sent in pieces, so a long turn is not one
    // giant line arriving late
    const owed = current.text.slice(current.sentLen)
    if (owed.trim() && (now - current.changedAt > 2500 || owed.length > 220)) {
      send(current.who, owed, current.at)
      current.sentLen = current.text.length
      current.at = now
    }
  }

  function captionsOn() {
    if (!IS_MEET || capTimer) return
    current = null
    let tries = 0
    const tryOn = () => {
      if (turnCaptionsOn() || ++tries > 20) return
      setTimeout(tryOn, 1500)
    }
    tryOn()
    hideCaptions(!showCc)
    let ticks = 0
    capTimer = setInterval(() => {
      if (!showCc) foldCaptions()
      pollCaptions()
      // switched off by a stray press of "c"? on again, quietly
      if (++ticks % 20 === 0) turnCaptionsOn()
    }, 700)
  }
  function captionsOff() {
    if (capTimer) clearInterval(capTimer)
    capTimer = null
    hideCaptions(false)
    if (current && current.text.length > current.sentLen) send(current.who, current.text.slice(current.sentLen), current.at)
    current = null
  }

  // ---------- on the page ----------

  function mount() {
    const here = MEETING.test(location.href)
    if (!here) {
      if (root.parentElement && !pip) root.remove()
      return
    }
    if (!pip && !document.body.contains(root)) document.body.appendChild(root)
  }
  render()
  mount()
  new MutationObserver(mount).observe(document.documentElement, { childList: true, subtree: false })
  let lastHref = location.href
  setInterval(() => {
    if (location.href !== lastHref) {
      lastHref = location.href
      mount()
    }
  }, 1000)
  // what the worker already knows about this tab (a refresh mid-session)
  void ask({ type: 'sitca:card:state' }).then((c) => {
    if (c && c.state && c.state !== 'idle') {
      card = c
      render()
      if (c.state === 'recording') {
        captionsOn()
        watchCall()
      }
    }
  })
})()
