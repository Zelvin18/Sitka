// Sitca on the meeting page.
//
// A small card in the corner of a Google Meet, Zoom, Teams, Webex or Whereby
// call, or a YouTube video. It never
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
  const MEETING = /^https:\/\/(meet\.google\.com\/[a-z]{3}-[a-z]{4}-[a-z]{3}|[a-z0-9.-]*zoom\.us\/(wc|j)\/|teams\.(microsoft|live)\.com\/|teams\.cloud\.microsoft\/|(www\.|m\.)?youtube\.com\/(watch|live\/)|[a-z0-9.-]*webex\.com\/(meet|join|wbxmjs|webappng)|[a-z0-9.-]*whereby\.com\/[^/?#]+)/
  const IS_MEET = location.hostname === 'meet.google.com'
  // what is on this page, for the card's words: a meeting, or a video
  const IS_VIDEO = /youtube\.com$/.test(location.hostname)
  const THING = IS_VIDEO ? 'video' : 'meeting'
  const CAN_FLOAT = 'documentPictureInPicture' in window

  const MARK =
    '<svg class="sc-mark" viewBox="0 0 64 64" aria-hidden="true"><circle cx="32" cy="32" r="22" fill="none" stroke="currentColor" stroke-width="7"/><circle cx="52" cy="22" r="6" fill="currentColor"/></svg>'

  const MIC_ON = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/></svg>'
  const MIC_OFF = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 9v5a3 3 0 0 0 5.1 2.1M15 10V6a3 3 0 0 0-6 0M5 11a7 7 0 0 0 11.3 5.5M19 11a7 7 0 0 1-.6 2.8M12 18v3M3 3l18 18"/></svg>'

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
  // the card's own stylesheet as text, kept from the start: the floating
  // window is dressed from it, and it must be there even if the extension has
  // been reloaded underneath this page since
  let cssText = ''
  try {
    fetch(chrome.runtime.getURL('meet.css'))
      .then((r) => (r.ok ? r.text() : ''))
      .then((t) => (cssText = t || ''))
      .catch(() => undefined)
  } catch {
    /* no stylesheet text: the link is tried instead */
  }
  /** true when the extension was updated or reloaded while this page stayed open */
  const stale = () => {
    try {
      return !chrome.runtime || !chrome.runtime.id
    } catch {
      return true
    }
  }

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

  // Talking into a muted microphone: a word from the card, the way the call
  // itself does it, pointing at the microphone button. Gone by itself.
  let nudgeTimer = null
  function nudgeMic() {
    if (card.state !== 'recording' || card.mic) return
    const mic = root.querySelector('.sc-mic')
    if (!mic) return
    let n = root.querySelector('.sc-nudge')
    if (!n) {
      n = (root.ownerDocument || document).createElement('div')
      n.className = 'sc-nudge'
      n.innerHTML = '<b>Are you talking?</b> Your microphone is off. Press it to be in the recording.<i></i>'
      mic.parentElement.appendChild(n)
    }
    // placed under the microphone button, its arrow pointing up at it
    const row = mic.parentElement
    const r = mic.getBoundingClientRect()
    const rr = row.getBoundingClientRect()
    const centre = r.left - rr.left + r.width / 2
    n.style.setProperty('--sc-arrow-x', `${Math.round(centre)}px`)
    n.classList.add('in')
    mic.classList.add('nudged')
    if (nudgeTimer) clearTimeout(nudgeTimer)
    nudgeTimer = setTimeout(() => {
      n.classList.remove('in')
      mic.classList.remove('nudged')
    }, 5000)
  }

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg && msg.type === 'sitca:nudge' && msg.what === 'mic') {
      nudgeMic()
      return
    }
    if (msg && msg.type === 'sitca:nudge' && msg.what === 'still') {
      askStill(msg.why)
      return
    }
    if (msg && msg.type === 'sitca:card' && msg.card) {
      const was = card.state
      const before = card
      card = msg.card
      if (card.state !== 'recording') showQr = false
      if (card.state === 'idle' || card.state === 'choose' || card.state === 'starting') chat = []
      // While recording, the engine writes every few seconds (the last line
      // heard, the microphone). Redrawing the whole card each time would
      // blink, drop the scroll and reload the QR code: only the words that
      // changed are touched, unless the card's shape itself has changed.
      if (was === 'recording' && card.state === 'recording' && sameShape(before, card)) {
        touchRecording()
        return
      }
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

  /** Two recording cards drawn the same way, give or take the words. */
  function sameShape(a, b) {
    return (
      a.mode === b.mode &&
      (a.hostUrl || '') === (b.hostUrl || '') &&
      (a.qr || '') === (b.qr || '') &&
      (a.mic === undefined) === (b.mic === undefined) &&
      a.startedAt === b.startedAt
    )
  }
  /** The words on a recording card that change while it runs. */
  function touchRecording() {
    const last = root.querySelector('.sc-last')
    if (last) {
      const text = card.lastLine || 'Listening…'
      if (last.textContent !== text) {
        last.textContent = text
        last.title = card.lastLine || ''
      }
    }
    const mic = root.querySelector('.sc-mic')
    if (mic && card.mic !== undefined) {
      const off = !card.mic
      if (mic.classList.contains('off') !== off) {
        mic.classList.toggle('off', off)
        mic.title = card.mic ? 'Your microphone is in the recording. Press to mute it.' : 'Your microphone is muted. Press to include it.'
        mic.innerHTML = card.mic ? MIC_ON : MIC_OFF
      }
    }
  }

  /**
   * "Still there?" on the card: nothing heard for a while, or the picture
   * gone. One press keeps the session going; Stop ends it; no answer and
   * the engine ends it by itself in a few minutes.
   */
  let stillBox = null
  function askStill(why) {
    if (why === 'no') {
      if (stillBox) stillBox.remove()
      stillBox = null
      return
    }
    if (card.state !== 'recording') return
    if (!stillBox) {
      stillBox = (root.ownerDocument || document).createElement('div')
      stillBox.className = 'sc-still'
    }
    stillBox.innerHTML = `<b>${why === 'gone' ? 'The picture has closed.' : 'Still there?'}</b><span>${
      why === 'gone' ? 'The window being recorded is gone. Still going?' : 'Sitca has heard nothing for a while. Ends by itself in 3 minutes.'
    }</span><div class="sc-still-b"><button type="button" class="sc-mini sc-stop" data-act="stop">End</button><button type="button" class="sc-mini sc-here" data-act="here">I’m here</button></div>`
    const anchor = root.querySelector('.sc-anchor') || root.firstElementChild
    if (anchor && anchor.parentElement) anchor.parentElement.insertBefore(stillBox, anchor.nextSibling)
    else root.appendChild(stillBox)
  }

  // ---------- the floating window ----------

  async function float() {
    if (!CAN_FLOAT || pip) return
    let w = null
    try {
      w = await window.documentPictureInPicture.requestWindow({ width: 380, height: 470 })
    } catch {
      return
    }
    pip = w
    // the window is never left blank: its colour first, then its stylesheet
    // from the text kept at the start (or by link), then the card itself
    try {
      w.document.title = 'Sitca'
      w.document.documentElement.style.cssText = 'overflow:hidden;height:100%;background:#131315'
      w.document.body.style.cssText = 'margin:0;height:100%;overflow:hidden;background:#131315'
      if (cssText) {
        const st = w.document.createElement('style')
        st.textContent = cssText
        w.document.head.appendChild(st)
      } else {
        const link = w.document.createElement('link')
        link.rel = 'stylesheet'
        link.href = chrome.runtime.getURL('meet.css')
        w.document.head.appendChild(link)
      }
    } catch {
      /* dressed as far as it could be */
    }
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

  /** Copy text from whichever window the card is in; the old way as a fallback. */
  async function copyText(text) {
    const win = (root.ownerDocument && root.ownerDocument.defaultView) || window
    try {
      await win.navigator.clipboard.writeText(text)
      return true
    } catch {
      /* the window may not count as focused: the older way below */
    }
    try {
      const doc = root.ownerDocument || document
      const ta = doc.createElement('textarea')
      ta.value = text
      ta.setAttribute('readonly', '')
      ta.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0'
      doc.body.appendChild(ta)
      ta.focus()
      ta.select()
      const ok = doc.execCommand('copy')
      ta.remove()
      return ok
    } catch {
      return false
    }
  }

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
  /**
   * An answer, drawn: bold, headings, bullet and numbered lists, paragraphs.
   * Everything is escaped first; only the marks Sitca itself writes become
   * markup. The copy button still copies the words (see `plain`).
   */
  function rich(s) {
    const text = String(s || '')
      .replace(/\[\[(\d+:\d{2}(?::\d{2})?)\]\]/g, '(at $1)')
      .trim()
    const inline = (t) => esc(t).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>').replace(/`([^`]+)`/g, '<code>$1</code>')
    const out = []
    let list = null // 'ul' | 'ol'
    let para = []
    const flushPara = () => {
      if (para.length) out.push('<p>' + para.map(inline).join('<br>') + '</p>')
      para = []
    }
    const closeList = () => {
      if (list) out.push('</' + list + '>')
      list = null
    }
    for (const raw of text.split('\n')) {
      const line = raw.trim()
      if (!line) {
        flushPara()
        closeList()
        continue
      }
      const h = line.match(/^#{1,4}\s+(.+)$/)
      const ul = line.match(/^[-*•]\s+(.+)$/)
      const ol = line.match(/^\d+[.)]\s+(.+)$/)
      if (h) {
        flushPara()
        closeList()
        out.push('<h4>' + inline(h[1]) + '</h4>')
      } else if (ul || ol) {
        flushPara()
        const kind = ul ? 'ul' : 'ol'
        if (list !== kind) {
          closeList()
          list = kind
          out.push('<' + kind + '>')
        }
        out.push('<li>' + inline((ul || ol)[1]) + '</li>')
      } else {
        closeList()
        para.push(line)
      }
    }
    flushPara()
    closeList()
    return out.join('')
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
        html += `<div class="sc-title">Capture this ${THING}</div>
        <button type="button" class="sc-opt" data-act="start" data-mode="record">
          <span class="sc-opt-t">Just record</span>
          <span class="sc-opt-d">Recording, live captions, notes and a recap, for you.</span>
        </button>
        <button type="button" class="sc-opt" data-act="start" data-mode="host">
          <span class="sc-opt-t">Host on Sitca</span>
          <span class="sc-opt-d">${IS_VIDEO ? 'The same, plus a link so others watch along and ask.' : 'The same, plus a link so people in the room follow along and ask.'}</span>
        </button>`
      } else if (st === 'needIcon') {
        // Chrome's one rule: a tab is only recorded once the person has
        // pressed the extension itself. The shortcut is the quickest press.
        html += `<div class="sc-title">One press, and Sitca is in</div>
        <p class="sc-p">${card.key ? `Press <kbd class="sc-key">${esc(card.key)}</kbd>, or the ` : 'Press the '}<b>Sitca icon</b> in Chrome’s toolbar, top right. Chrome asks for that once per tab; then this card does the rest.</p>
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
      html = `<div class="sc-bar sc-slim sc-anchor">
        <span class="sc-dot"></span>
        <span class="sc-time" data-clock>${clock(card.startedAt)}</span>
        <span class="sc-label">${live ? 'Live on Sitca' : 'Recording'}</span>
        ${card.mic === undefined ? '' : `<button type="button" class="sc-mini sc-mic${card.mic ? '' : ' off'}" data-act="mic" title="${card.mic ? 'Your microphone is in the recording. Press to mute it.' : 'Your microphone is muted. Press to include it.'}" aria-label="Microphone">${card.mic ? MIC_ON : MIC_OFF}</button>`}
        ${CAN_FLOAT ? '<button type="button" class="sc-mini" data-act="float" title="Chat with Sitca privately, in a window the recording never sees">Chat</button>' : ''}
        <button type="button" class="sc-mini" data-act="open" title="Open this session in Sitca">Open</button>
        <button type="button" class="sc-mini sc-stop" data-act="stop">Stop</button>
      </div>`
    } else if (st === 'recording') {
      const live = card.mode === 'host' || Boolean(card.hostUrl)
      html = `<div class="sc-panel">
        <div class="sc-row sc-top sc-anchor">
          <span class="sc-dot"></span>
          <span class="sc-time" data-clock>${clock(card.startedAt)}</span>
          <span class="sc-label">${live ? 'Live on Sitca' : 'Recording'}</span>
          ${card.mic === undefined ? '' : `<button type="button" class="sc-mini sc-mic${card.mic ? '' : ' off'}" data-act="mic" title="${card.mic ? 'Your microphone is in the recording. Press to mute it.' : 'Your microphone is muted. Press to include it.'}" aria-label="Microphone">${card.mic ? MIC_ON : MIC_OFF}</button>`}
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
      chat.forEach((m, i) => {
        html +=
          m.role === 'sitca'
            ? `<div class="sc-msg sc-sitca sc-rich">${rich(m.text)}<button type="button" class="sc-copy" data-act="copymsg" data-i="${i}" title="Copy this answer" aria-label="Copy this answer"><svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/></svg></button></div>`
            : `<div class="sc-msg sc-you">${esc(m.text)}</div>`
      })
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
    if (stale() && act !== 'close' && act !== 'copy' && act !== 'copymsg') {
      card = { state: 'failed', error: 'Sitca was updated while this page was open. Reload the page, then try again.' }
      render()
      return
    }
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
      captionsOff()
      unwatchCall()
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
        void copyText(url).then((ok) => {
          b.textContent = ok ? 'Copied ✓' : 'Could not copy'
          setTimeout(() => (b.textContent = was), 1800)
        })
      }
    } else if (act === 'qr') {
      showQr = !showQr
      render()
    } else if (act === 'float') {
      void float()
    } else if (act === 'copymsg') {
      const m = chat[Number(b.getAttribute('data-i'))]
      if (m) {
        void copyText(plain(m.text)).then((ok) => {
          if (!ok) return
          b.classList.add('done')
          setTimeout(() => b.classList.remove('done'), 1600)
        })
      }
    } else if (act === 'here') {
      askStill('no')
      void ask({ type: 'sitca:card:still' })
    } else if (act === 'mic') {
      const on = !card.mic
      card = { ...card, mic: on }
      render()
      void ask({ type: 'sitca:card:mic', on })
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
      chat.push({ role: 'sitca', text: String((r && r.answer) || 'Sitca could not answer just now.') })
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
    if (IS_VIDEO) {
      // on YouTube the "call" is the video: the watch page, or the small
      // player that carries it onto other pages. Back to the home page with
      // no player, and there is nothing left to record.
      const onVideo = /^\/(watch|live\/)/.test(location.pathname)
      const mini = document.querySelector('ytd-app[miniplayer-is-active], ytd-miniplayer[active], ytd-miniplayer[is-open]')
      return onVideo || Boolean(mini)
    }
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
        captionsOff()
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
    // Up from the words to the top of Meet's caption block: the language
    // chip, the font controls and the band the lines sit in. Hard limits:
    // never anything that holds the call's controls, a participant's tile,
    // or more than most of the window. Cameras may all be off, so tiles are
    // recognised by Meet's own participant marks, not by video.
    const holdsCall = (el) =>
      Boolean(
        el.querySelector(
          'video, [data-participant-id], [data-self-name], [data-requested-participant-id], [aria-label*="leave call" i], [aria-label*="Leave call" i], [data-tooltip*="Leave call" i], [aria-label*="microphone" i], [aria-label*="camera" i]'
        )
      )
    const tooBig = (el) => el.getBoundingClientRect().height > window.innerHeight * 0.6
    let el = region
    for (let depth = 0; depth < 6; depth++) {
      const parent = el.parentElement
      if (!parent || parent === document.body || parent === document.documentElement) break
      if (holdsCall(parent) || tooBig(parent)) break
      el = parent
    }
    if (holdsCall(el) || tooBig(el)) return region
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
        const tag = String(c.tagName || '').toUpperCase()
        if (tag === 'IMG' || tag === 'SVG' || tag === 'BUTTON' || c instanceof SVGElement) continue
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
    // the card belongs on a meeting or a video page; but once a session is
    // running it stays wherever the tab goes on this site (YouTube's small
    // player carries the video onto other pages)
    const running = card.state === 'recording' || card.state === 'starting' || card.state === 'ending'
    const here = MEETING.test(location.href) || running
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
