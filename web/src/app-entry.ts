/**
 * Web entry for the FULL Sitka app: sign in, install the cloud backend as
 * window.sitka, then boot the untouched desktop renderer (React app).
 */
import { createClient } from '@supabase/supabase-js'

const SUPA_URL = import.meta.env.VITE_SUPABASE_URL as string
const SUPA_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY as string
const sb = createClient(SUPA_URL, SUPA_KEY)

const el = (id: string): HTMLElement => document.getElementById(id) as HTMLElement

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

async function launch(): Promise<void> {
  el('gatecard').classList.add('hidden')
  el('gateload').classList.remove('hidden')
  lockFrame()
  const { installWebApi } = await import('./webApi')
  await installWebApi(sb)
  await import('../../src/renderer/src/main')
  el('gate').classList.add('hidden')
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
  ;(el('gsignin') as HTMLButtonElement).onclick = async () => {
    err.textContent = ''
    const { error } = await sb.auth.signInWithPassword({
      email: (el('gemail') as HTMLInputElement).value.trim(),
      password: (el('gpassword') as HTMLInputElement).value
    })
    if (error) {
      err.textContent = error.message
      return
    }
    await launch()
  }
  ;(el('gsignup') as HTMLButtonElement).onclick = async () => {
    err.textContent = ''
    const { data: d, error } = await sb.auth.signUp({
      email: (el('gemail') as HTMLInputElement).value.trim(),
      password: (el('gpassword') as HTMLInputElement).value
    })
    if (error) {
      err.textContent = error.message
      return
    }
    if (!d.session) {
      err.textContent = 'Account created — check your email to confirm, then sign in.'
      return
    }
    await launch()
  }
  ;(el('gpassword') as HTMLInputElement).addEventListener('keydown', (e) => {
    if (e.key === 'Enter') (el('gsignin') as HTMLButtonElement).click()
  })
}
void boot()
