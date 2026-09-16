import React from 'react'
import { DECK_TEMPLATES, DOC_TEMPLATES, toHex, type DeckTemplate, type DocTemplate } from '../lib/pdf'

/**
 * The five styles a document or a deck can be made in, each shown as a
 * miniature of its own cover, drawn from the same definitions the PDF, the
 * PowerPoint and the web page use, so what is picked is what arrives.
 */

interface Props {
  kind: 'document' | 'presentation'
  value: string
  onChange: (id: string) => void
  compact?: boolean
}

function DocMini({ t }: { t: DocTemplate }): React.JSX.Element {
  const page = t.page ? toHex(t.page) : '#ffffff'
  const ink = toHex(t.ink)
  const accent = toHex(t.accent)
  const muted = toHex(t.muted)
  const rule = toHex(t.rule)
  const font = t.serif ? 'Georgia, "Times New Roman", serif' : 'inherit'
  const lines = (color: string, widths: number[], top: number, left = 14, h = 3): React.JSX.Element[] =>
    widths.map((w, i) => <i key={i} style={{ position: 'absolute', left: `${left}%`, top: `${top + i * 6}%`, width: `${w}%`, height: h, background: color, borderRadius: 1, opacity: 0.8 }} />)
  const title = (left: number, top: number, color: string, size = 11): React.JSX.Element => (
    <b style={{ position: 'absolute', left: `${left}%`, top: `${top}%`, color, fontFamily: font, fontSize: size, lineHeight: 1.05, fontWeight: 800, letterSpacing: '-0.02em' }}>
      Title of
      <br />
      the piece
    </b>
  )
  switch (t.cover) {
    case 'editorial':
      return (
        <span className="sp-mini" style={{ background: page }}>
          <i style={{ position: 'absolute', left: '14%', right: '14%', top: '24%', height: 1.5, background: ink }} />
          {title(14, 30, ink)}
          <i style={{ position: 'absolute', left: '14%', top: '58%', width: '30%', height: 2, background: muted, opacity: 0.6 }} />
          {lines(rule, [72, 72, 50], 68)}
        </span>
      )
    case 'block':
      return (
        <span className="sp-mini" style={{ background: page }}>
          <i style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: '36%', background: accent }} />
          {title(44, 34, ink)}
          {lines(rule, [40, 30], 64, 44)}
        </span>
      )
    case 'band':
      return (
        <span className="sp-mini" style={{ background: page }}>
          <i style={{ position: 'absolute', left: 0, right: 0, top: '42%', bottom: 0, background: accent }} />
          {title(12, 52, '#ffffff')}
          <i style={{ position: 'absolute', left: '12%', top: '34%', width: '16%', height: 3, background: accent }} />
        </span>
      )
    case 'paper':
      return (
        <span className="sp-mini" style={{ background: page }}>
          <i style={{ position: 'absolute', left: '14%', top: '20%', width: '18%', height: 2.5, background: accent }} />
          {title(14, 27, ink)}
          <i style={{ position: 'absolute', left: '14%', top: '56%', width: '34%', height: 2, background: accent, opacity: 0.7 }} />
          {lines(rule, [72, 60], 68)}
        </span>
      )
    case 'dark':
      return (
        <span className="sp-mini" style={{ background: ink }}>
          <i style={{ position: 'absolute', left: '14%', top: '18%', width: 8, height: 8, background: accent }} />
          {title(14, 32, '#ffffff')}
          {lines('#3a3a40', [60, 40], 66)}
        </span>
      )
  }
}

function DeckMini({ t }: { t: DeckTemplate }): React.JSX.Element {
  const font = t.serif ? 'Georgia, "Times New Roman", serif' : 'inherit'
  const accent = toHex(t.accent)
  return (
    <span className="sp-mini wide" style={{ background: toHex(t.bg) }}>
      {/* the title slide, front */}
      <span style={{ position: 'absolute', inset: '8% 30% 8% 6%', background: toHex(t.titleBg), borderRadius: 3, boxShadow: '0 3px 10px rgba(0,0,0,.25)' }}>
        <b style={{ position: 'absolute', left: '12%', top: '30%', right: '8%', color: toHex(t.titleInk), fontFamily: font, fontSize: 10, lineHeight: 1.05, fontWeight: 800, letterSpacing: '-0.02em' }}>
          The talk
        </b>
        {t.bar !== 'none' && <i style={{ position: 'absolute', left: '12%', top: '64%', width: '22%', height: 2, background: t.id === 'mono' ? toHex(t.titleInk) : t.id === 'midnight' ? accent : '#ffffff' }} />}
      </span>
      {/* a content slide, behind */}
      <span style={{ position: 'absolute', inset: '22% 6% 22% 58%', background: toHex(t.bg), border: `1px solid ${t.id === 'midnight' ? '#2a2a30' : 'rgba(0,0,0,.12)'}`, borderRadius: 3, overflow: 'hidden' }}>
        {t.bar === 'left' && <i style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: 3, background: accent }} />}
        {t.bar === 'top' && <i style={{ position: 'absolute', left: 0, top: 0, right: 0, height: 3, background: accent }} />}
        <i style={{ position: 'absolute', left: '18%', top: '20%', width: '55%', height: 3, background: t.id === 'ocean' ? accent : toHex(t.ink), borderRadius: 1 }} />
        {t.bar === 'under' && <i style={{ position: 'absolute', left: '18%', top: '36%', width: '20%', height: 2, background: accent }} />}
        {[0, 1, 2].map((i) => (
          <i key={i} style={{ position: 'absolute', left: '18%', top: `${50 + i * 14}%`, width: `${60 - i * 10}%`, height: 2, background: toHex(t.muted), opacity: 0.7 }} />
        ))}
      </span>
    </span>
  )
}

export default function StylePicker({ kind, value, onChange, compact }: Props): React.JSX.Element {
  const list = kind === 'document' ? DOC_TEMPLATES : DECK_TEMPLATES
  return (
    <div className={`sp${compact ? ' compact' : ''}`}>
      {!compact && (
        <div className="create-ground-label">
          Style <span className="setup-optional">the look of every file made from it</span>
        </div>
      )}
      <div className="sp-row">
        {list.map((t) => (
          <button
            key={t.id}
            type="button"
            className={`sp-card${value === t.id ? ' on' : ''}`}
            onClick={() => onChange(t.id)}
            title={t.desc}
          >
            {kind === 'document' ? <DocMini t={t as DocTemplate} /> : <DeckMini t={t as DeckTemplate} />}
            <span className="sp-name">{t.name}</span>
            {!compact && <span className="sp-desc">{t.desc}</span>}
          </button>
        ))}
      </div>
    </div>
  )
}
