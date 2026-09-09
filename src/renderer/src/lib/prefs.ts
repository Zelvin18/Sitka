import type { Settings } from '@shared/types'

/**
 * Appearance preferences are applied to the document root so CSS can react:
 * data-theme = light | dark (absent = follow the device), data-textsize.
 * They are also cached in localStorage so the very first paint after a reload
 * already uses them, before the settings have loaded.
 */
const CACHE = 'sitka.appearance'

export function applyAppearance(theme: Settings['theme'], textSize: Settings['textSize']): void {
  const root = document.documentElement
  if (theme === 'light' || theme === 'dark') root.dataset.theme = theme
  else delete root.dataset.theme
  if (textSize === 'large') root.dataset.textsize = 'large'
  else delete root.dataset.textsize
  try {
    localStorage.setItem(CACHE, JSON.stringify({ theme: theme ?? 'system', textSize: textSize ?? 'normal' }))
  } catch {
    /* private mode */
  }
}

/** Called before the first render: restores the cached appearance instantly. */
export function applyCachedAppearance(): void {
  try {
    const c = JSON.parse(localStorage.getItem(CACHE) || '{}') as {
      theme?: Settings['theme']
      textSize?: Settings['textSize']
    }
    const root = document.documentElement
    if (c.theme === 'light' || c.theme === 'dark') root.dataset.theme = c.theme
    if (c.textSize === 'large') root.dataset.textsize = 'large'
  } catch {
    /* ignore */
  }
}
