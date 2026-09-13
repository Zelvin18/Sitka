/// <reference lib="dom" />
/**
 * On a phone, the keyboard must only appear when the person taps a field.
 * Anything else that moves focus into a text field on its own — a dialog that
 * opens, a list that re-renders, a script that calls focus() — is undone here,
 * so the keyboard never rises out of nowhere.
 *
 * A focus that follows a tap or a key press within the last moment is the
 * person's own and is left alone.
 */
export function installFocusGuard(): () => void {
  if (typeof window === 'undefined' || typeof document === 'undefined') return () => undefined
  const coarse = window.matchMedia?.('(pointer: coarse)').matches
  const narrow = window.innerWidth < 860
  if (!coarse && !narrow) return () => undefined

  let lastIntent = 0
  const noteIntent = (): void => {
    lastIntent = Date.now()
  }
  const isField = (t: EventTarget | null): t is HTMLElement => {
    const e = t as HTMLElement | null
    if (!e || !e.tagName) return false
    const tag = e.tagName.toLowerCase()
    return tag === 'input' || tag === 'textarea' || tag === 'select' || e.isContentEditable
  }
  const onFocus = (e: FocusEvent): void => {
    if (!isField(e.target)) return
    if (Date.now() - lastIntent < 1200) return
    // keep the element focusable for later, just without the keyboard now
    e.target.blur()
  }
  document.addEventListener('pointerdown', noteIntent, true)
  document.addEventListener('touchstart', noteIntent, true)
  document.addEventListener('keydown', noteIntent, true)
  document.addEventListener('focusin', onFocus, true)
  return () => {
    document.removeEventListener('pointerdown', noteIntent, true)
    document.removeEventListener('touchstart', noteIntent, true)
    document.removeEventListener('keydown', noteIntent, true)
    document.removeEventListener('focusin', onFocus, true)
  }
}
