import React, { useEffect, useMemo, useState } from 'react'
import type { Creation, CreationKind } from '@shared/types'
import { IconCopy, IconDownload, Mark } from '../lib/icons'
import { highlight } from '../lib/highlight'
import { copyRich } from '../lib/clipboard'

/**
 * The page shown while something is being made, in the place the finished
 * thing will take: a warm sky drifting slowly, the Sitka mark, and a line
 * about what is happening now. Code is written out on screen as it lands.
 * When it is done, the file is a tap away, and so is opening it.
 */

const LINES: Record<CreationKind, string[]> = {
  document: ['Reading your sessions', 'Finding the thread', 'Laying out the sections', 'Choosing every word', 'Setting the type', 'Almost there'],
  presentation: ['Reading your sessions', 'Deciding what each slide says', 'One idea per slide', 'Writing the speaker notes', 'Placing the last slide', 'Almost there'],
  code: ['Reading what was covered', 'Sketching the structure', 'Writing the files', 'Naming things well', 'Reading it back', 'Almost there']
}
const TITLE: Record<CreationKind, string> = {
  document: 'Designing your document',
  presentation: 'Designing your presentation',
  code: 'Writing your code'
}
const DONE: Record<CreationKind, string> = {
  document: 'Your document is ready',
  presentation: 'Your presentation is ready',
  code: 'Your code is written'
}

interface Props {
  kind: CreationKind
  /** the finished thing, once it exists */
  made: Creation | null
  /** what the code files look like, once they exist */
  code?: { name: string; lang: string; code: string }[]
  onOpen: () => void
  onDownload: () => void
}

export default function Designing({ kind, made, code, onOpen, onDownload }: Props): React.JSX.Element {
  const lines = LINES[kind]
  const [step, setStep] = useState(0)
  useEffect(() => {
    if (made) return
    const t = window.setInterval(() => setStep((s) => Math.min(lines.length - 1, s + 1)), 2600)
    return () => clearInterval(t)
  }, [made, lines.length])

  // the code, written out as it arrives: quickly, but visibly
  const first = code?.[0]
  const [typed, setTyped] = useState(0)
  useEffect(() => {
    if (!first) return
    const total = first.code.length
    const perTick = Math.max(3, Math.ceil(total / 240))
    const t = window.setInterval(() => {
      setTyped((n) => {
        if (n >= total) {
          clearInterval(t)
          return n
        }
        return Math.min(total, n + perTick)
      })
    }, 16)
    return () => clearInterval(t)
  }, [first])
  const shown = useMemo(() => (first ? first.code.slice(0, typed) : ''), [first, typed])
  const [copied, setCopied] = useState(false)

  return (
    <div className={`designing${made ? ' done' : ''}`}>
      <div className="designing-sky" aria-hidden="true">
        <i />
        <i />
        <i />
      </div>
      <div className="designing-in">
        <div className="designing-mark">
          <Mark size={34} live={!made} />
        </div>
        <h2 className="designing-title">{made ? DONE[kind] : TITLE[kind]}</h2>
        {!made ? (
          <div className="designing-line" key={step}>
            {lines[step]}
          </div>
        ) : (
          <div className="designing-line still">{made.title}</div>
        )}

        {first && (
          <div className="designing-code">
            <div className="designing-code-head">
              <span className="code-file-name">{first.name}</span>
              {code && code.length > 1 && <span className="code-file-lang">+ {code.length - 1} more</span>}
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                style={{ marginLeft: 'auto' }}
                onClick={() =>
                  void copyRich(first.code).then((ok) => {
                    if (ok) {
                      setCopied(true)
                      setTimeout(() => setCopied(false), 1600)
                    }
                  })
                }
              >
                <IconCopy size={13} />
                {copied ? 'Copied' : 'Copy'}
              </button>
            </div>
            <pre className="code-pre designing-pre">
              <code>
                {highlight(shown, first.lang || first.name.split('.').pop() || '').map((tk, k) =>
                  tk.kind === 'plain' ? tk.text : <span key={k} className={`tk-${tk.kind}`}>{tk.text}</span>
                )}
                {typed < first.code.length && <span className="designing-caret" />}
              </code>
            </pre>
          </div>
        )}

        {made && (
          <div className="designing-actions">
            <button type="button" className="btn btn-primary btn-lg" onClick={onDownload}>
              <IconDownload size={15} />
              Download
            </button>
            <button type="button" className="btn btn-lg" onClick={onOpen}>
              Open it
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
