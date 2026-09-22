/**
 * Google sign-in, with Firebase as the front door.
 *
 * Google will not let a site on vercel.app publish its own sign-in screen,
 * so the account chooser is shown by Firebase instead, on Google's own
 * domain. Firebase hands back Google's proof of who the person is (an ID
 * token), and that proof is passed to Supabase, which owns the accounts.
 * Nothing about the account changes: same user id, same sessions, same
 * everything; people who signed up with a password and the same Gmail land
 * in the same account.
 *
 * The Firebase library is large, so it is fetched only when this page shows
 * the sign-in card, in the background, and used the moment the button is
 * pressed.
 */

// These are public identifiers, meant to sit in the page; they are not secrets.
const CONFIG = {
  apiKey: 'AIzaSyDhJshHFqUYXwANttkHrgY3-WDbcOX2wJ8',
  authDomain: 'sitcaai.firebaseapp.com',
  projectId: 'sitcaai',
  appId: '1:775358764227:web:5e24ea30b7c36d6f91fe76'
}

type AuthMod = typeof import('firebase/auth')
type Loaded = { mod: AuthMod; auth: import('firebase/auth').Auth }

let loading: Promise<Loaded> | null = null
const REDIRECT_MARK = 'sitka.googleRedirect'

async function load(): Promise<Loaded> {
  const [{ initializeApp, getApps }, mod] = await Promise.all([import('firebase/app'), import('firebase/auth')])
  const app = getApps()[0] ?? initializeApp(CONFIG)
  const auth = mod.getAuth(app)
  // Firebase's own session is not wanted: Supabase keeps the real one.
  mod.setPersistence(auth, mod.inMemoryPersistence).catch(() => undefined)
  return { mod, auth }
}

/** Start fetching the library now, so the button answers at once later. */
export function warmGoogle(): void {
  if (!loading) loading = load().catch((e) => { loading = null; throw e })
}

function provider(mod: AuthMod): import('firebase/auth').GoogleAuthProvider {
  const p = new mod.GoogleAuthProvider()
  p.addScope('email')
  p.addScope('profile')
  // no forced account chooser: one signed-in account that has used Sitca
  // before goes straight through; Google asks only when there are several
  return p
}

function tokenOf(mod: AuthMod, result: import('firebase/auth').UserCredential | null): string | null {
  if (!result) return null
  const cred = mod.GoogleAuthProvider.credentialFromResult(result)
  return cred?.idToken || null
}

/**
 * Show Google's account chooser and return Google's ID token for the person
 * who chose. This is the pop-up way, which suits a computer. A browser that
 * refuses the pop-up, or keeps the pop-up's storage apart from the page's
 * (every phone does), raises `popup-no-good`: the caller then sends the page
 * itself to Google, the plain way round.
 */
export async function googleIdToken(): Promise<string | null> {
  warmGoogle()
  const { mod, auth } = await (loading as Promise<Loaded>)
  try {
    const result = await mod.signInWithPopup(auth, provider(mod))
    const token = tokenOf(mod, result)
    mod.signOut(auth).catch(() => undefined)
    if (!token) throw new Error('Google did not say who you are. Try again.')
    return token
  } catch (e) {
    const code = (e as { code?: string })?.code || ''
    if (code === 'auth/popup-blocked' || code === 'auth/operation-not-supported-in-this-environment') {
      throw new Error('popup-no-good')
    }
    if (code === 'auth/popup-closed-by-user' || code === 'auth/cancelled-popup-request') {
      throw new Error('The Google window was closed before you chose an account.')
    }
    if (code === 'auth/unauthorized-domain') {
      throw new Error('This address is not yet allowed for Google sign-in.')
    }
    if (code === 'auth/network-request-failed') {
      throw new Error('Could not reach Google. Check your connection and try again.')
    }
    throw e
  }
}

// ---------- the quiet way in ----------

/**
 * The Google client the Firebase project made ("Web client (auto created by
 * Google Service)" in Google Cloud). Google's own sign-in script needs it to
 * offer the quiet sign-in; it is a public identifier, like the config above.
 * Empty means the quiet sign-in is simply not offered.
 */
export const GOOGLE_CLIENT_ID =
  (import.meta.env.VITE_GOOGLE_CLIENT_ID as string | undefined) ||
  '775358764227-42f5vqba55h56kiva1sud98f0dm7cfmu.apps.googleusercontent.com'

const SIGNED_OUT = 'sitka.signedOut'

interface GsiCredential {
  credential: string
  select_by?: string
}
interface GsiMoment {
  isNotDisplayed(): boolean
  isSkippedMoment(): boolean
  isDismissedMoment(): boolean
  getNotDisplayedReason(): string
  getSkippedReason(): string
  getDismissedReason(): string
}
interface GsiId {
  initialize(o: Record<string, unknown>): void
  renderButton(parent: HTMLElement, o: Record<string, unknown>): void
  prompt(cb?: (m: GsiMoment) => void): void
  cancel(): void
  disableAutoSelect(): void
}
type GsiWindow = Window & { google?: { accounts?: { id?: GsiId } } }

function randomCode(): string {
  const bytes = new Uint8Array(24)
  crypto.getRandomValues(bytes)
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('')
}

function gsiScript(): Promise<GsiId> {
  const w = window as GsiWindow
  if (w.google?.accounts?.id) return Promise.resolve(w.google.accounts.id)
  return new Promise((resolve, reject) => {
    const s = document.createElement('script')
    s.src = 'https://accounts.google.com/gsi/client'
    s.async = true
    s.defer = true
    s.onload = () => {
      const id = (window as GsiWindow).google?.accounts?.id
      if (id) resolve(id)
      else reject(new Error('Google sign-in script did not load.'))
    }
    s.onerror = () => reject(new Error('Google sign-in script did not load.'))
    document.head.appendChild(s)
  })
}

/**
 * Sign the person in without asking, the way Google does on sites they use:
 * when the browser holds their Google session and they have signed in here
 * with it before, Google hands over their proof at once and they are in.
 * When Google is less sure, it shows its own small "Continue as …" card at
 * the top of the page; the ordinary sign-in card stays underneath for anyone
 * who ignores it, and Google withdraws its card by itself after a while.
 *
 * Someone who signed out on purpose is asked, not swept back in: for that
 * visit Google shows its card instead of choosing for them.
 *
 * `onToken` is called with Google's ID token, the same proof the button
 * produces. Nothing happens at all when the client id is not set, when the
 * page is inside another site's frame, or when Google decides not to offer.
 */
export async function quietGoogle(onToken: (token: string, nonce: string) => void, mount?: HTMLElement | null): Promise<void> {
  if (!GOOGLE_CLIENT_ID) return
  if (window.top !== window.self) return
  // A one-time code ties Google's proof to this very page load: Google is
  // given its fingerprint and stamps the proof with it; Supabase is given the
  // code itself and checks the stamp matches. Nothing replayed elsewhere fits.
  const nonce = randomCode()
  let stamped: string
  try {
    stamped = await sha256Hex(nonce)
  } catch {
    return // no crypto (an old browser over plain http): the card is there
  }
  let signedOut = false
  try {
    signedOut = localStorage.getItem(SIGNED_OUT) === '1'
    localStorage.removeItem(SIGNED_OUT)
  } catch {
    /* ignore */
  }
  let id: GsiId
  try {
    id = await gsiScript()
  } catch {
    return // no Google today: the card is there
  }
  if (signedOut) id.disableAutoSelect()
  id.initialize({
    client_id: GOOGLE_CLIENT_ID,
    callback: (r: GsiCredential) => {
      if (r?.credential) onToken(r.credential, nonce)
    },
    // Chrome wants it inside `params` now; the older field is kept for
    // browsers that have not caught up.
    nonce: stamped,
    params: { nonce: stamped },
    auto_select: !signedOut,
    cancel_on_tap_outside: false,
    itp_support: true,
    use_fedcm_for_prompt: true,
    context: 'signin'
  })
  // Google's own button, drawn where the card asked for it. When Google
  // knows the person it reads "Continue as <their name>", and one tap is
  // the whole sign-in — no chooser, no second window.
  if (mount) {
    try {
      id.renderButton(mount, {
        type: 'standard',
        theme: 'filled_black',
        size: 'large',
        shape: 'pill',
        text: 'continue_with',
        logo_alignment: 'center',
        width: Math.min(360, Math.max(240, mount.clientWidth || 320))
      })
      mount.classList.remove('hidden')
    } catch {
      /* Google would not draw it: our own button is there */
    }
  }
  id.prompt()
}

/** The page is leaving the sign-in card (a password sign-in went through): Google's card goes too. */
export function cancelQuietGoogle(): void {
  try {
    ;(window as GsiWindow).google?.accounts?.id?.cancel()
  } catch {
    /* ignore */
  }
}

/**
 * Back from a full-page trip to Google (the rare pop-up-blocked case): the
 * token Google sent along, or null when this page load is not a return.
 */
export async function finishGoogleRedirect(): Promise<string | null> {
  let expected = false
  try {
    expected = sessionStorage.getItem(REDIRECT_MARK) === '1'
    sessionStorage.removeItem(REDIRECT_MARK)
  } catch {
    /* ignore */
  }
  if (!expected) return null
  warmGoogle()
  const { mod, auth } = await (loading as Promise<Loaded>)
  const result = await mod.getRedirectResult(auth).catch(() => null)
  const token = tokenOf(mod, result)
  mod.signOut(auth).catch(() => undefined)
  return token
}
