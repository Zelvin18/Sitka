/**
 * Web entry for the FULL Sitka app: sign in, install the cloud backend as
 * window.sitka, then boot the untouched desktop renderer (React app).
 *
 * Speed: the two big pieces of code (the cloud backend and the app itself)
 * start downloading the moment the page opens, while the sign-in check runs.
 * The app renders as soon as the backend is installed — nothing waits in line.
 */
import { createClient } from '@supabase/supabase-js'

const SUPA_URL = import.meta.env.VITE_SUPABASE_URL as string
const SUPA_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY as string
const sb = createClient(SUPA_URL, SUPA_KEY)

const el = (id: string): HTMLElement => document.getElementById(id) as HTMLElement
// A refreshed page starts at its top. Browsers put a reloaded page back
// where it was scrolled, which lands people mid-section with no bearings.
if ('scrollRestoration' in history) history.scrollRestoration = 'manual'
window.addEventListener('pageshow', () => window.scrollTo(0, 0))

// The app's modules read this flag the moment they load, so it is set before
// any of them arrive: this is the web build, wherever the code came from.
;(window as unknown as { sitkaWeb: boolean }).sitkaWeb = true

// start fetching the code now; it is used a moment later
const webApiModule = import('./webApi')
let resolveReady: () => void = () => undefined
const ready = new Promise<void>((r) => {
  resolveReady = r
})
;(window as unknown as { sitkaReady: Promise<void> }).sitkaReady = ready
const rendererModule = import('../../src/renderer/src/main')

/**
 * The app is a fixed frame: it never zooms and never pans sideways. Phones
 * ignore the viewport's user-scalable flag, so pinch and double-tap zoom are
 * stopped here as well; scrolling stays inside the app's own panels.
 */
function lockFrame(): void {
  document.addEventListener('gesturestart', (e) => e.preventDefault(), { passive: false })
  document.addEventListener(
    'touchmove',
    (e) => {
      if ((e as TouchEvent & { scale?: number }).scale !== undefined && (e as TouchEvent & { scale?: number }).scale !== 1) {
        e.preventDefault()
      }
    },
    { passive: false }
  )
  let lastTap = 0
  document.addEventListener(
    'touchend',
    (e) => {
      const now = Date.now()
      if (now - lastTap < 320) e.preventDefault()
      lastTap = now
    },
    { passive: false }
  )
  document.addEventListener('wheel', (e) => {
    if (e.ctrlKey) e.preventDefault()
  }, { passive: false })
  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && (e.key === '+' || e.key === '-' || e.key === '=' || e.key === '0')) e.preventDefault()
  })
}

/**
 * A page that cannot open must say so, never sit on "Opening your workspace"
 * for good. Each step is named, so a slow one is reported by name; a step
 * that fails shows what happened and a way to try again; and the commonest
 * failure of all, a page from before a deploy asking for code that no longer
 * exists, reloads itself once to fetch the current page.
 */
const RELOADED = 'sitka.reloaded-once'
const looksStale = (msg: string): boolean =>
  /dynamically imported module|Importing a module script failed|error loading dynamically|Loading chunk|Unexpected token '<'/i.test(msg)

function report(message: string, stack?: string): void {
  // straight to the errors table: the backend may be the thing that failed
  void sb
    .from('client_errors')
    .insert({ page: location.pathname, message: message.slice(0, 500), stack: (stack ?? '').slice(0, 2000), ua: navigator.userAgent.slice(0, 200) })
    .then(() => undefined, () => undefined)
}

function showOpenProblem(stage: string, detail: string): void {
  const box = el('gateload')
  box.innerHTML = ''
  const p = document.createElement('div')
  p.className = 'gwait'
  p.style.flexDirection = 'column'
  p.style.gap = '14px'
  const t = document.createElement('span')
  t.textContent = 'Sitka could not open.'
  const d = document.createElement('span')
  d.style.cssText = 'font-weight:500;font-size:13px;color:var(--t3);max-width:360px;text-align:center'
  d.textContent = `It stopped while ${stage}. ${detail}`.trim()
  const b = document.createElement('button')
  b.className = 'gbtn'
  b.style.marginTop = '4px'
  b.innerHTML = '<span>Try again</span>'
  b.onclick = () => location.reload()
  p.append(t, d, b)
  box.appendChild(p)
}

async function launch(): Promise<void> {
  el('gatecard').classList.add('hidden')
  el('gateload').classList.remove('hidden')
  lockFrame()
  let stage = 'fetching the app'
  const began = Date.now()
  // Slow, not broken: say so at twenty seconds and offer a way out, and write
  // down which step it was, so a slow step shows up in the operations view.
  const slow = window.setTimeout(() => {
    const w = el('gateload').querySelector('span')
    if (w) w.textContent = 'Still opening. Your connection looks slow.'
    const b = document.createElement('button')
    b.className = 'gforgot'
    b.textContent = 'Reload'
    b.onclick = () => location.reload()
    el('gateload').appendChild(b)
    report(`slow open: 20s and still ${stage}`)
  }, 20000)
  try {
    const { installWebApi } = await webApiModule
    stage = 'connecting to your account'
    await installWebApi(sb)
    resolveReady()
    stage = 'loading the workspace'
    await rendererModule
    window.clearTimeout(slow)
    sessionStorage.removeItem(RELOADED)
    const took = Date.now() - began
    if (took > 8000) report(`open took ${Math.round(took / 1000)}s`)
    // The sign-in form leaves the page entirely. Left in the document, hidden,
    // it still counts as a login form: an iPhone would offer to fill the
    // password into it at odd moments, keyboard and all.
    el('gate').remove()
  } catch (err) {
    window.clearTimeout(slow)
    const msg = err instanceof Error ? err.message : String(err)
    const stack = err instanceof Error ? err.stack : undefined
    report(`open failed while ${stage}: ${msg}`, stack)
    if (looksStale(msg) && !sessionStorage.getItem(RELOADED)) {
      // the page is older than the site: fetch the current one, once
      sessionStorage.setItem(RELOADED, '1')
      location.reload()
      return
    }
    showOpenProblem(
      stage,
      looksStale(msg)
        ? 'The site was updated while this page was open.'
        : /failed to fetch|load failed|network/i.test(msg)
          ? 'Check your connection.'
          : msg.slice(0, 140)
    )
  }
}

/**
 * The page remembered for a refresh belongs to the session that was signed
 * in; a fresh sign-in starts at the home page, not wherever the last person
 * on this browser left off.
 */
function forgetPlace(): void {
  try {
    sessionStorage.removeItem('sitka.view')
    localStorage.removeItem('sitka.space')
  } catch {
    /* no storage: nothing was remembered */
  }
}

async function boot(): Promise<void> {
  const isRecovery = location.hash.includes('type=recovery')
  const { data } = await sb.auth.getSession()
  if (data.session?.user) {
    if (isRecovery) {
      const np = window.prompt('Choose a new password (6+ characters):')
      if (np && np.length >= 6) await sb.auth.updateUser({ password: np })
      history.replaceState(null, '', location.pathname)
    }
    await launch()
    return
  }
  const err = el('gerr')
  ;(el('gforgot') as HTMLButtonElement).onclick = async () => {
    const email = (el('gemail') as HTMLInputElement).value.trim()
    if (!email) {
      err.textContent = 'Type your email above first, then tap Forgot password.'
      return
    }
    const { error } = await sb.auth.resetPasswordForEmail(email, {
      redirectTo: location.origin + '/app'
    })
    err.textContent = error ? error.message : 'Reset link sent — check your email.'
  }
  // One request at a time: the button says it is working and ignores a
  // second press; a request that never answers is given up on after a while.
  let busy = false
  const withBusy = async (btn: HTMLButtonElement, label: string, run: () => Promise<boolean>): Promise<void> => {
    if (busy) return
    busy = true
    const was = btn.innerHTML
    btn.disabled = true
    btn.innerHTML = `<span>${label}</span>`
    let proceed = false
    try {
      proceed = await Promise.race([
        run(),
        new Promise<boolean>((_, reject) =>
          setTimeout(() => reject(new Error('The sign-in service did not answer. Check your connection and try again.')), 25000)
        )
      ])
    } catch (e) {
      err.textContent = e instanceof Error ? e.message : String(e)
    } finally {
      busy = false
      btn.disabled = false
      btn.innerHTML = was
    }
    // the workspace opening has its own patience and its own messages
    if (proceed) await launch()
  }
  const creds = (): { email: string; password: string } => ({
    email: (el('gemail') as HTMLInputElement).value.trim(),
    password: (el('gpassword') as HTMLInputElement).value
  })
  const plain = (m: string): string =>
    /invalid login credentials/i.test(m)
      ? 'That email and password do not match.'
      : /email not confirmed/i.test(m)
        ? 'Confirm your email first: the link is in your inbox.'
        : /rate limit|too many/i.test(m)
          ? 'Too many tries. Wait a minute, then try again.'
          : /password.*(6|characters)/i.test(m)
            ? 'The password needs at least 6 characters.'
            : /already registered|already exists/i.test(m)
              ? 'There is already an account with that email. Sign in instead.'
              : m
  ;(el('gsignin') as HTMLButtonElement).onclick = () =>
    withBusy(el('gsignin') as HTMLButtonElement, 'Signing in…', async () => {
      err.textContent = ''
      const c = creds()
      if (!c.email || !c.password) {
        err.textContent = 'Type your email and password first.'
        return false
      }
      const { error } = await sb.auth.signInWithPassword(c)
      if (error) {
        err.textContent = plain(error.message)
        return false
      }
      forgetPlace()
      return true
    })
  ;(el('gsignup') as HTMLButtonElement).onclick = () =>
    withBusy(el('gsignup') as HTMLButtonElement, 'Creating your account…', async () => {
      err.textContent = ''
      const c = creds()
      if (!c.email || !c.password) {
        err.textContent = 'Type your email and a password first.'
        return false
      }
      if (c.password.length < 6) {
        err.textContent = 'The password needs at least 6 characters.'
        return false
      }
      // the name, so Sitka is personal from the first day rather than an email address
      const name = ((el('gname') as HTMLInputElement | null)?.value ?? '').trim().slice(0, 80)
      if (!name) {
        err.textContent = 'Type your name first — it is what Sitka will call you.'
        return false
      }
      const { data: d, error } = await sb.auth.signUp({ ...c, options: { data: { full_name: name } } })
      if (error) {
        err.textContent = plain(error.message)
        return false
      }
      if (!d.session) {
        err.textContent = 'Account created — check your email to confirm, then sign in.'
        return false
      }
      forgetPlace()
      return true
    })
  ;(el('gpassword') as HTMLInputElement).addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return
    // Enter submits whichever action the page is showing: sign in or create.
    const create = el('gsignup') as HTMLButtonElement
    const visible = create.offsetParent !== null && !create.hidden
    ;(visible ? create : (el('gsignin') as HTMLButtonElement)).click()
  })
}
void boot()
