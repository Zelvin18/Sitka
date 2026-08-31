/**
 * Web entry for the FULL Sitka app: sign in, install the cloud backend as
 * window.sitka, then boot the untouched desktop renderer (React app).
 */
import { createClient } from '@supabase/supabase-js'

const SUPA_URL = import.meta.env.VITE_SUPABASE_URL as string
const SUPA_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY as string
const sb = createClient(SUPA_URL, SUPA_KEY)

const el = (id: string): HTMLElement => document.getElementById(id) as HTMLElement

async function launch(): Promise<void> {
  el('gatecard').classList.add('hidden')
  el('gateload').classList.remove('hidden')
  const { installWebApi } = await import('./webApi')
  await installWebApi(sb)
  await import('../../src/renderer/src/main')
  el('gate').classList.add('hidden')
}

async function boot(): Promise<void> {
  const { data } = await sb.auth.getSession()
  if (data.session?.user) {
    await launch()
    return
  }
  const err = el('gerr')
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
