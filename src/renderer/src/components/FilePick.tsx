import React, { useCallback, useEffect, useRef, useState } from 'react'
import { IconDoc, IconImage, IconPhoto } from '../lib/icons'

/**
 * One way to add a file anywhere in Sitka. A tap opens a small sheet asking
 * what is being added — a picture from the library, a photo taken now, or a
 * document — and the right picker opens for it. On a phone that is the
 * difference between a picker that works and one that does nothing: the
 * inputs live in the page, one per source, and the tap that chooses a source
 * is the tap that opens it.
 */

const TOUCH = typeof navigator !== 'undefined' && navigator.maxTouchPoints > 1

/** Documents Sitka can read into text. Pictures are read by the vision model. */
export const DOC_ACCEPT = '.pdf,.txt,.md,.csv,.json,.vtt,.srt,application/pdf,text/plain,text/markdown,text/csv'

interface Props {
  /** what to do with what was chosen */
  onFiles: (files: File[]) => void | Promise<void>
  /** pictures make sense here (default true) */
  images?: boolean
  /** documents make sense here (default true) */
  documents?: boolean
  multiple?: boolean
  /** a line under the title of the sheet */
  hint?: string
  /** the trigger; `open` shows the sheet */
  children: (open: () => void) => React.ReactNode
}

export default function FilePick({
  onFiles,
  images = true,
  documents = true,
  multiple = true,
  hint,
  children
}: Props): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const libraryRef = useRef<HTMLInputElement>(null)
  const cameraRef = useRef<HTMLInputElement>(null)
  const docsRef = useRef<HTMLInputElement>(null)

  const chosen = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>): void => {
      const files = Array.from(e.target.files ?? [])
      e.target.value = ''
      setOpen(false)
      if (files.length > 0) void onFiles(files)
    },
    [onFiles]
  )

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open])

  const show = useCallback((): void => {
    // with one kind of thing to add there is nothing to ask
    if (images && !documents && !TOUCH) {
      libraryRef.current?.click()
      return
    }
    if (documents && !images) {
      docsRef.current?.click()
      return
    }
    setOpen(true)
  }, [images, documents])

  return (
    <>
      {children(show)}
      {/* the pickers themselves, in the page so a phone will open them */}
      {images && (
        <input ref={libraryRef} type="file" accept="image/*" multiple={multiple} hidden onChange={chosen} />
      )}
      {images && (
        <input ref={cameraRef} type="file" accept="image/*" capture="environment" hidden onChange={chosen} />
      )}
      {documents && (
        <input ref={docsRef} type="file" accept={DOC_ACCEPT} multiple={multiple} hidden onChange={chosen} />
      )}
      {open && (
        <div className="dialog-overlay pick-overlay" onMouseDown={() => setOpen(false)}>
          <div className="pick-sheet" role="dialog" aria-label="What are you adding?" onMouseDown={(e) => e.stopPropagation()}>
            <div className="pick-title">What are you adding?</div>
            {hint && <div className="pick-hint">{hint}</div>}
            <div className="pick-options">
              {images && (
                <button type="button" className="pick-opt" onClick={() => libraryRef.current?.click()}>
                  <span className="pick-opt-icon">
                    <IconImage size={18} strokeWidth={1.7} />
                  </span>
                  <span className="pick-opt-text">
                    <span className="pick-opt-title">{TOUCH ? 'Photo library' : 'A picture'}</span>
                    <span className="pick-opt-sub">A slide, a page, a whiteboard, a poster</span>
                  </span>
                </button>
              )}
              {images && TOUCH && (
                <button type="button" className="pick-opt" onClick={() => cameraRef.current?.click()}>
                  <span className="pick-opt-icon">
                    <IconPhoto size={18} strokeWidth={1.7} />
                  </span>
                  <span className="pick-opt-text">
                    <span className="pick-opt-title">Take a photo</span>
                    <span className="pick-opt-sub">Point the camera at it</span>
                  </span>
                </button>
              )}
              {documents && (
                <button type="button" className="pick-opt" onClick={() => docsRef.current?.click()}>
                  <span className="pick-opt-icon">
                    <IconDoc size={18} strokeWidth={1.7} />
                  </span>
                  <span className="pick-opt-text">
                    <span className="pick-opt-title">{TOUCH ? 'Files' : 'A document'}</span>
                    <span className="pick-opt-sub">PDF, text, notes, captions</span>
                  </span>
                </button>
              )}
            </div>
            <button type="button" className="btn btn-ghost pick-cancel" onClick={() => setOpen(false)}>
              Cancel
            </button>
          </div>
        </div>
      )}
    </>
  )
}
