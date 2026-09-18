// The microphone, asked for where Chrome will actually ask.
//
// A side panel never shows the microphone prompt: Chrome only asks on a
// proper page. This is that page. It opens for a moment, Chrome asks, and
// the answer is remembered for the whole extension, so from then on the
// panel records the person's own voice along with the call.

const title = document.getElementById('t')
const message = document.getElementById('m')
const again = document.getElementById('b')
again.hidden = true

function tell(ok) {
  try {
    chrome.runtime.sendMessage({ type: 'sitca:mic', ok }).catch(() => undefined)
  } catch {
    /* the panel may have closed */
  }
}

async function ask() {
  again.hidden = true
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
    stream.getTracks().forEach((t) => t.stop())
    title.textContent = 'Sitca can hear you'
    message.innerHTML = '<span class="ok">Done.</span> This tab closes by itself; your session is in the panel.'
    tell(true)
    setTimeout(() => window.close(), 1400)
  } catch (err) {
    const name = err && err.name ? err.name : ''
    title.textContent = 'The microphone is blocked'
    message.textContent =
      name === 'NotAllowedError'
        ? 'Chrome is refusing the microphone for Sitca. Open Chrome settings, Privacy and security, Site settings, Microphone, and allow Sitca there — then press Ask again.'
        : name === 'NotFoundError'
          ? 'No microphone was found on this computer. The call itself is still being recorded.'
          : 'The microphone could not be opened. Close anything else using it, then press Ask again.'
    again.hidden = false
    tell(false)
  }
}

again.addEventListener('click', () => void ask())
void ask()
