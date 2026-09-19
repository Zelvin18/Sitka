// The extension's page on the website: /extension.
//
// Two faces. Arrived at by anyone, it says what the extension is and offers
// it. Arrived at from the extension itself the moment it is installed
// (#installed), it says the three things to do first.

/** the Chrome Web Store listing; '' until Sitca is published there */
const STORE = ''

const ua = navigator.userAgent
const mobile = /Android|iPhone|iPad|iPod/i.test(ua) || (navigator as { userAgentData?: { mobile?: boolean } }).userAgentData?.mobile === true
// every browser built on Chrome carries this; Safari and Firefox do not
const chromium = Boolean((window as { chrome?: unknown }).chrome) && !/Firefox/i.test(ua)
const mac = /Mac|iPhone|iPad/i.test(navigator.platform || ua)

if (location.hash === '#installed') document.body.classList.add('installed')

// the shortcut as this computer shows it
for (const k of document.querySelectorAll<HTMLElement>('[data-key]')) k.textContent = mac ? '⌥⇧S' : 'Alt+Shift+S'

const wrong = document.getElementById('wrong')
const buttons = [document.getElementById('add'), document.getElementById('add2')].filter(Boolean) as HTMLAnchorElement[]

if (mobile) {
  if (wrong) wrong.innerHTML = '<b>This is for a computer.</b> Phones and iPads cannot take Chrome extensions. Open this page on your laptop, or use Sitca in the browser here: <a href="/app" style="text-decoration:underline">sitcaai.vercel.app/app</a>.'
  document.body.classList.add('wrong')
} else if (!chromium) {
  if (wrong) wrong.innerHTML = '<b>Open this page in Chrome.</b> The extension runs in Google Chrome, Microsoft Edge, Brave, Arc, Opera and Vivaldi. Sitca itself works in any browser at <a href="/app" style="text-decoration:underline">sitcaai.vercel.app/app</a>.'
  document.body.classList.add('wrong')
} else if (STORE) {
  for (const b of buttons) {
    b.href = STORE
    b.target = '_blank'
    b.rel = 'noopener'
  }
} else {
  for (const b of buttons) {
    b.classList.add('soon')
    b.removeAttribute('href')
    b.querySelector('span')?.replaceChildren('Coming to the Chrome Web Store')
    if (!b.querySelector('span')) b.textContent = 'Coming to the Chrome Web Store'
  }
}
