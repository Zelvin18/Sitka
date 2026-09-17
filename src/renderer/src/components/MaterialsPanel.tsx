import React, { useState } from 'react'
import type { SessionMaterial } from '@shared/types'
import { sizeLabel } from '@shared/materialsLogic'
import ConfirmDialog from './ConfirmDialog'
import FilePick from './FilePick'
import { IconDoc, IconPlus, IconTrash, Mark } from '../lib/icons'
import { nameForPaste, readFileToText } from '../lib/readFile'

interface Props {
  materials: SessionMaterial[]
  /** add a material (name + extracted text); resolves when stored */
  onAdd: (name: string, text: string) => Promise<void>
  onRemove: (id: string) => Promise<void>
  /** short form: no explainer, used inside the live page */
  compact?: boolean
}

/**
 * The slides, notes or readings for a session. Sitca reads them so it knows
 * what the session is about, where it is heading, and the exact terms in play.
 */
export default function MaterialsPanel({
  materials,
  onAdd,
  onRemove,
  compact
}: Props): React.JSX.Element {
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [pasting, setPasting] = useState(false)
  const [pasteText, setPasteText] = useState('')
  const [pendingRemove, setPendingRemove] = useState<SessionMaterial | null>(null)

  const addFiles = async (files: FileList | File[] | null): Promise<void> => {
    if (!files || files.length === 0) return
    setError(null)
    for (const f of Array.from(files)) {
      setBusy(f.type.startsWith('image/') ? 'the picture' : f.name)
      try {
        const res = await readFileToText(f)
        if ('error' in res) {
          setError(res.error)
          continue
        }
        await onAdd(res.name, res.text)
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err))
      }
    }
    setBusy(null)
  }

  // pasted text is simply taken: it names itself from its first line
  const addPaste = async (text: string): Promise<void> => {
    if (!text.trim()) return
    setBusy('Pasted text')
    setError(null)
    try {
      await onAdd(nameForPaste(text), text)
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
          Give Sitca the slides, notes, reading or agenda. It uses them to know what the
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
        {busy ? (
          <span className="mat-busy">
            <Mark size={15} live /> Reading {busy}…
          </span>
        ) : (
          <>
            <FilePick onFiles={addFiles} hint="Sitca reads it and keeps the words.">
              {(open) => (
                <button className="btn btn-sm" onClick={open}>
                  <IconPlus size={13} strokeWidth={2.2} />
                  Add
                </button>
              )}
            </FilePick>
            <button className="btn btn-ghost btn-sm" onClick={() => setPasting((v) => !v)}>
              Paste text
            </button>
            <span className="mat-drop-hint">A PDF, a text file, a picture of a page, or drop files here</span>
          </>
        )}
      </div>

      {pasting && (
        <div className="mat-paste">
          <textarea
            className="input"
            rows={5}
            autoFocus
            placeholder="Paste here — it is added the moment it lands"
            value={pasteText}
            onChange={(e) => setPasteText(e.target.value)}
            onPaste={(e) => {
              const text = e.clipboardData.getData('text/plain')
              if (text.trim().length > 0) {
                e.preventDefault()
                void addPaste(text)
              }
            }}
          />
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="btn btn-primary btn-sm" onClick={() => void addPaste(pasteText)} disabled={!pasteText.trim()}>
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
          Sitca has read {materials.length === 1 ? 'this document' : `these ${materials.length} documents`}{' '}
          and will use {materials.length === 1 ? 'it' : 'them'} in every answer, note and summary.
        </div>
      )}

      {pendingRemove && (
        <ConfirmDialog
          title="Remove this material?"
          message={`Sitca will stop using “${pendingRemove.name}” for this session.`}
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
