import React, { useCallback } from 'react'

interface Props {
  direction: 'vertical' | 'horizontal'
  /** called with pointer position while dragging */
  onMove: (clientX: number, clientY: number) => void
  /** double-click resets to the default size */
  onReset?: () => void
}

/** Draggable divider between panes (vertical = resizes columns, horizontal = rows). */
export default function Splitter({ direction, onMove, onReset }: Props): React.JSX.Element {
  const onPointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      e.preventDefault()
      const target = e.currentTarget
      try {
        target.setPointerCapture(e.pointerId)
      } catch {
        /* noop */
      }
      const move = (ev: PointerEvent): void => onMove(ev.clientX, ev.clientY)
      const up = (): void => {
        window.removeEventListener('pointermove', move)
        window.removeEventListener('pointerup', up)
        document.body.classList.remove(
          direction === 'vertical' ? 'dragging-col' : 'dragging-row'
        )
      }
      window.addEventListener('pointermove', move)
      window.addEventListener('pointerup', up)
      document.body.classList.add(
        direction === 'vertical' ? 'dragging-col' : 'dragging-row'
      )
    },
    [onMove, direction]
  )

  return (
    <div
      className={direction === 'vertical' ? 'splitter-v' : 'splitter-h'}
      onPointerDown={onPointerDown}
      onDoubleClick={onReset}
      title="Drag to resize · double-click to reset"
    />
  )
}
