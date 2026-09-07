import React, { useEffect, useState } from 'react'
import { IconDownload } from '../lib/icons'

export interface SaveFormat {
  id: string
  label: string
  /** one plain sentence: what you get and where it opens */
  desc: string
  /** shown as a small tag, e.g. ".docx" */
  tag: string
}

interface Props {
  title: string
  formats: SaveFormat[]
  onSave: (formatId: string) => void
  onCancel: () => void
}

/**
 * One Save button, one clear choice. The user picks a format, reads what it
 * gives them, and presses Save. Escape or clicking outside cancels.
 */
export default function SaveDialog({ title, formats, onSave, onCancel }: Props): React.JSX.Element {
  const [choice, setChoice] = useState(formats[0]?.id ?? '')

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onCancel()
      if (e.key === 'Enter' && choice) onSave(choice)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onCancel, onSave, choice])

  return (
    <div className="dialog-overlay" onMouseDown={onCancel}>
      <div className="dialog save-dialog" onMouseDown={(e) => e.stopPropagation()}>
        <div className="dialog-title">Save “{title}”</div>
        <div className="dialog-message">Choose how you want it, then press Save.</div>
        <div className="save-options" role="radiogroup">
          {formats.map((f) => (
            <button
              key={f.id}
              role="radio"
              aria-checked={choice === f.id}
              className={`save-option${choice === f.id ? ' on' : ''}`}
              onClick={() => setChoice(f.id)}
              onDoubleClick={() => onSave(f.id)}
            >
              <span className="save-option-radio" />
              <span className="save-option-text">
                <span className="save-option-label">
                  {f.label}
                  <span className="save-option-tag">{f.tag}</span>
                </span>
                <span className="save-option-desc">{f.desc}</span>
              </span>
            </button>
          ))}
        </div>
        <div className="dialog-actions">
          <button className="btn" onClick={onCancel}>
            Cancel
          </button>
          <button className="btn btn-primary" onClick={() => onSave(choice)} disabled={!choice} autoFocus>
            <IconDownload size={14} />
            Save
          </button>
        </div>
      </div>
    </div>
  )
}
