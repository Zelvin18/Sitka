import React, { useEffect } from 'react'

interface Props {
  title: string
  message: string
  confirmLabel?: string
  onConfirm: () => void
  onCancel: () => void
}

/** Small centered confirmation dialog. Cancel is focused by default. */
export default function ConfirmDialog({
  title,
  message,
  confirmLabel = 'Delete',
  onConfirm,
  onCancel
}: Props): React.JSX.Element {
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onCancel()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onCancel])

  return (
    <div className="dialog-overlay" onMouseDown={onCancel}>
      <div className="dialog" onMouseDown={(e) => e.stopPropagation()}>
        <div className="dialog-title">{title}</div>
        <div className="dialog-message">{message}</div>
        <div className="dialog-actions">
          <button className="btn" onClick={onCancel} autoFocus>
            Cancel
          </button>
          <button className="btn btn-danger" onClick={onConfirm}>
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  )
}
