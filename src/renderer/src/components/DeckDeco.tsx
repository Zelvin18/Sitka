import React from 'react'
import { deckDesign, type Paint } from '@shared/deckDesign'
import { deckTemplate, toHex } from '../lib/pdf'

/**
 * The design's shapes behind a slide on screen — the same list the
 * PowerPoint and the PDF draw, so the preview is the file.
 */
export default function DeckDeco({ templateId, title }: { templateId?: string | null; title: boolean }): React.JSX.Element {
  const t = deckTemplate(templateId ?? undefined)
  const d = deckDesign(t.id)
  const paint = (p: Paint): string =>
    p === 'accent'
      ? toHex(t.accent)
      : p === 'ink'
        ? toHex(t.ink)
        : p === 'bg'
          ? toHex(t.bg)
          : p === 'titleBg'
            ? toHex(t.titleBg)
            : p === 'titleInk'
              ? toHex(t.titleInk)
              : p === 'muted'
                ? toHex(t.muted)
                : p === 'white'
                  ? '#ffffff'
                  : '#000000'
  return (
    <span className="deck-deco" aria-hidden="true">
      {(title ? d.title : d.content).map((s, k) => {
        if (s.kind === 'circle') {
          // the radius is a share of the height; the width follows the 16:9 frame
          const r = (s.r ?? 0.1) * 100
          return (
            <i
              key={k}
              className="deck-deco-circle"
              style={{
                left: `${s.x * 100}%`,
                top: `${s.y * 100}%`,
                height: `${r * 2}%`,
                background: paint(s.paint),
                opacity: s.alpha
              }}
            />
          )
        }
        return (
          <i
            key={k}
            style={{
              left: `${s.x * 100}%`,
              top: `${s.y * 100}%`,
              width: `${(s.w ?? 0) * 100}%`,
              height: `${(s.h ?? 0) * 100}%`,
              background: paint(s.paint),
              opacity: s.alpha
            }}
          />
        )
      })}
    </span>
  )
}
