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
  p.setCustomParameters({ prompt: 'select_account' })
  return p
}

function tokenOf(mod: AuthMod, result: import('firebase/auth').UserCredential | null): string | null {
  if (!result) return null
  const cred = mod.GoogleAuthProvider.credentialFromResult(result)
  return cred?.idToken || null
}

/**
 * Show Google's account chooser and return Google's ID token for the person
 * who chose. A pop-up first (it works everywhere, including Safari); when a
 * browser refuses the pop-up, the page itself goes to Google and comes back,
 * in which case this returns null and `finishGoogleRedirect` is answered on
 * the way back.
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
      try {
        sessionStorage.setItem(REDIRECT_MARK, '1')
        // a recap being kept survives the round trip
        if (location.hash.startsWith('#keep=')) sessionStorage.setItem('sitka.afterAuth', location.hash)
      } catch {
        /* ignore */
      }
      await mod.signInWithRedirect(auth, provider(mod))
      return null
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
