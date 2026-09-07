import React, { useRef, useState } from 'react'
import type { SessionMaterial } from '@shared/types'
import { sizeLabel } from '@shared/materialsLogic'
import ConfirmDialog from './ConfirmDialog'
import { IconDoc, IconPlus, IconTrash, Mark } from '../lib/icons'

interface Props {
  materials: SessionMaterial[]
  /** add a material (name + extracted text); resolves when stored */
  onAdd: (name: string, text: string) => Promise<void>
  onRemove: (id: string) => Promise<void>
  /** short form: no explainer, used inside the live page */
  compact?: boolean
}

const ACCEPT = '.pdf,.txt,.md,.csv,.json,.vtt,.srt'

/**
 * The slides, notes or readings for a session. Sitka reads them so it knows
 * what the session is about, where it is heading, and the exact terms in play.
 */
export default function MaterialsPanel({
  materials,
  onAdd,
  onRemove,
  compact
}: Props): React.JSX.Element {
  const fileRef = useRef<HTMLInputElement>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [pasting, setPasting] = useState(false)
  const [pasteName, setPasteName] = useState('')
  const [pasteText, setPasteText] = useState('')
  const [pendingRemove, setPendingRemove] = useState<SessionMaterial | null>(null)

  const addFiles = async (files: FileList | null): Promise<void> => {
    if (!files || files.length === 0) return
    setError(null)
    for (const f of Array.from(files)) {
      setBusy(f.name)
      try {
        const res = await window.sitka.extractMaterial(f.name, await f.arrayBuffer())
        if ('error' in res) {
          setError(res.error)
          continue
        }
        if (!res.text.trim()) {
          setError(`${f.name} has no readable text.`)
          continue
        }
        await onAdd(res.name, res.text)
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err))
      }
    }
    setBusy(null)
    if (fileRef.current) fileRef.current.value = ''
  }

  const addPaste = async (): Promise<void> => {
    if (!pasteText.trim()) return
    setBusy('Pasted text')
    setError(null)
    try {
      await onAdd(pasteName.trim() || 'Pasted notes', pasteText)
      setPasteName('')
      setPasteText('')
      setPasting(false)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className={`mat-panel${compact ? ' compact' : ''}`}>
      {!compact && (
        <div className="mat-explain">
          Give Sitka the slides, notes, reading or agenda. It uses them to know what the
          session is about, follow where it is heading, get every term and figure right, and
          answer questions the spoken words alone cannot.
        </div>
      )}

      <div
        className="mat-drop"
        onDragOver={(e) => {
          e.preventDefault()
          e.currentTarget.classList.add('over')
        }}
        onDragLeave={(e) => e.currentTarget.classList.remove('over')}
        onDrop={(e) => {
          e.preventDefault()
          e.currentTarget.classList.remove('over')
          void addFiles(e.dataTransfer.files)
        }}
      >
        <input
          ref={fileRef}
          type="file"
          accept={ACCEPT}
          multiple
          hidden
          onChange={(e) => void addFiles(e.target.files)}
        />
        {busy ? (
          <span className="mat-busy">
            <Mark size={15} live /> Reading {busy}…
          </span>
        ) : (
          <>
            <button className="btn btn-sm" onClick={() => fileRef.current?.click()}>
              <IconPlus size={13} strokeWidth={2.2} />
              Add file
            </button>
            <button className="btn btn-ghost btn-sm" onClick={() => setPasting((v) => !v)}>
              Paste text
            </button>
            <span className="mat-drop-hint">PDF, TXT, MD, CSV, or drop files here</span>
          </>
        )}
      </div>

      {pasting && (
        <div className="mat-paste">
          <input
            className="input"
            placeholder="Name (e.g. Lecture 4 notes)"
            value={pasteName}
            onChange={(e) => setPasteName(e.target.value)}
          />
          <textarea
            className="input"
            rows={5}
            placeholder="Paste the notes, outline or agenda…"
            value={pasteText}
            onChange={(e) => setPasteText(e.target.value)}
          />
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="btn btn-primary btn-sm" onClick={() => void addPaste()} disabled={!pasteText.trim()}>
              Add
            </button>
            <button className="btn btn-ghost btn-sm" onClick={() => setPasting(false)}>
              Cancel
            </button>
          </div>
        </div>
      )}

      {error && <div className="notice notice-error" style={{ marginTop: 8 }}>{error}</div>}

      {materials.length > 0 && (
        <div className="mat-list">
          {materials.map((m) => (
            <div key={m.id} className="mat-row">
              <span className="mat-row-icon">
                <IconDoc size={14} strokeWidth={1.7} />
              </span>
              <span className="mat-row-text">
                <span className="mat-row-name">{m.name}</span>
                <span className="mat-row-size">{sizeLabel(m.chars)}</span>
              </span>
              <button
                className="btn btn-ghost btn-sm"
                title="Remove"
                onClick={() => setPendingRemove(m)}
              >
                <IconTrash size={13} />
              </button>
            </div>
          ))}
        </div>
      )}

      {materials.length > 0 && (
        <div className="mat-knows">
          <Mark size={13} />
          Sitka has read {materials.length === 1 ? 'this document' : `these ${materials.length} documents`}{' '}
          and will use {materials.length === 1 ? 'it' : 'them'} in every answer, note and summary.
        </div>
      )}

      {pendingRemove && (
        <ConfirmDialog
          title="Remove this material?"
          message={`Sitka will stop using “${pendingRemove.name}” for this session.`}
          confirmLabel="Remove"
          onConfirm={() => {
            const m = pendingRemove
            setPendingRemove(null)
            void onRemove(m.id)
          }}
          onCancel={() => setPendingRemove(null)}
        />
      )}
    </div>
  )
}
