import React from 'react'

/**
 * Figures the AI can draw in an answer, so a chart, graph or diagram that was
 * on the presenter's screen can be seen again. Two small text formats:
 *
 * ```chart
 * type: bar            (bar | line)
 * title: Revenue by quarter
 * labels: Q1, Q2, Q3, Q4
 * 2024: 12, 18, 21, 30
 * 2025: 15, 22, 27, 35
 * ```
 *
 * ```flow
 * Input -> Model -> Output
 * Model -> Feedback: retrain
 * ```
 *
 * Everything is monochrome SVG in the app's own greys.
 */

const GREYS = ['currentColor', '#8a8a92', '#bdbdc3', '#dcdcdf', '#6a6a72', '#a4a4aa']

interface ChartSpec {
  type: 'bar' | 'line'
  title: string
  labels: string[]
  series: { name: string; values: number[] }[]
}

export function parseChart(body: string): ChartSpec | null {
  const spec: ChartSpec = { type: 'bar', title: '', labels: [], series: [] }
  for (const raw of body.split('\n')) {
    const line = raw.trim()
    if (!line) continue
    const idx = line.indexOf(':')
    if (idx < 0) continue
    const key = line.slice(0, idx).trim()
    const value = line.slice(idx + 1).trim()
    const lower = key.toLowerCase()
    if (lower === 'type') spec.type = /line/i.test(value) ? 'line' : 'bar'
    else if (lower === 'title') spec.title = value
    else if (lower === 'labels' || lower === 'x') spec.labels = value.split(',').map((s) => s.trim())
    else {
      const values = value.split(',').map((s) => Number(String(s).replace(/[^\d.eE+-]/g, '')))
      if (values.length && values.every((v) => Number.isFinite(v))) spec.series.push({ name: key, values })
    }
  }
  if (spec.series.length === 0) return null
  const n = Math.max(...spec.series.map((s) => s.values.length))
  while (spec.labels.length < n) spec.labels.push(String(spec.labels.length + 1))
  return spec
}

const fmt = (v: number): string =>
  Math.abs(v) >= 1000 ? v.toLocaleString(undefined, { maximumFractionDigits: 0 }) : String(Math.round(v * 100) / 100)

/** Nice axis maximum: 0, 50, 100, 120 … */
function niceMax(max: number): number {
  if (max <= 0) return 1
  const p = Math.pow(10, Math.floor(Math.log10(max)))
  const m = max / p
  const step = m <= 1 ? 1 : m <= 2 ? 2 : m <= 5 ? 5 : 10
  return step * p
}

export function Chart({ spec }: { spec: ChartSpec }): React.JSX.Element {
  const W = 600
  const H = 320
  const padL = 52
  const padR = 16
  const padT = spec.title ? 40 : 18
  const padB = 46
  const plotW = W - padL - padR
  const plotH = H - padT - padB
  const n = spec.labels.length
  const allValues = spec.series.flatMap((s) => s.values)
  const rawMax = Math.max(0, ...allValues)
  const rawMin = Math.min(0, ...allValues)
  const max = niceMax(rawMax)
  const min = rawMin < 0 ? -niceMax(-rawMin) : 0
  const y = (v: number): number => padT + plotH - ((v - min) / (max - min)) * plotH
  const ticks = 4
  const gridLines = Array.from({ length: ticks + 1 }, (_, i) => min + ((max - min) * i) / ticks)
  const groupW = plotW / Math.max(1, n)
  const barW = Math.min(46, (groupW * 0.7) / Math.max(1, spec.series.length))
  const xCenter = (i: number): number => padL + groupW * i + groupW / 2
  const showValues = n * spec.series.length <= 12

  return (
    <figure className="fig">
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={spec.title || 'Chart'}>
        {spec.title && (
          <text x={padL} y={22} className="fig-title">
            {spec.title}
          </text>
        )}
        {gridLines.map((g, i) => (
          <g key={i}>
            <line x1={padL} x2={W - padR} y1={y(g)} y2={y(g)} className="fig-grid" />
            <text x={padL - 8} y={y(g) + 4} textAnchor="end" className="fig-tick">
              {fmt(g)}
            </text>
          </g>
        ))}
        <line x1={padL} x2={W - padR} y1={y(0)} y2={y(0)} className="fig-axis" />
        {spec.labels.map((l, i) => (
          <text key={i} x={xCenter(i)} y={H - padB + 20} textAnchor="middle" className="fig-tick">
            {l.length > 14 ? l.slice(0, 13) + '…' : l}
          </text>
        ))}
        {spec.type === 'bar'
          ? spec.series.map((s, si) =>
              s.values.map((v, i) => {
                const x = xCenter(i) - (barW * spec.series.length) / 2 + si * barW
                const top = Math.min(y(v), y(0))
                const h = Math.abs(y(v) - y(0))
                return (
                  <g key={`${si}-${i}`}>
                    <rect x={x + 1} y={top} width={barW - 2} height={h} rx={3} fill={GREYS[si % GREYS.length]} />
                    {showValues && (
                      <text x={x + barW / 2} y={top - 5} textAnchor="middle" className="fig-value">
                        {fmt(v)}
                      </text>
                    )}
                  </g>
                )
              })
            )
          : spec.series.map((s, si) => {
              const pts = s.values.map((v, i) => `${xCenter(i)},${y(v)}`).join(' ')
              return (
                <g key={si}>
                  <polyline
                    points={pts}
                    fill="none"
                    stroke={GREYS[si % GREYS.length]}
                    strokeWidth={2.2}
                    strokeLinejoin="round"
                    strokeLinecap="round"
                  />
                  {s.values.map((v, i) => (
                    <g key={i}>
                      <circle cx={xCenter(i)} cy={y(v)} r={3.5} fill={GREYS[si % GREYS.length]} />
                      {showValues && (
                        <text x={xCenter(i)} y={y(v) - 9} textAnchor="middle" className="fig-value">
                          {fmt(v)}
                        </text>
                      )}
                    </g>
                  ))}
                </g>
              )
            })}
        {spec.series.length > 1 &&
          spec.series.map((s, si) => (
            <g key={si} transform={`translate(${padL + si * 130}, ${H - 8})`}>
              <rect x={0} y={-9} width={12} height={12} rx={2} fill={GREYS[si % GREYS.length]} />
              <text x={18} y={1} className="fig-tick">
                {s.name.length > 16 ? s.name.slice(0, 15) + '…' : s.name}
              </text>
            </g>
          ))}
      </svg>
    </figure>
  )
}

interface FlowSpec {
  nodes: string[]
  edges: { from: string; to: string; label?: string }[]
}

export function parseFlow(body: string): FlowSpec | null {
  const nodes: string[] = []
  const edges: FlowSpec['edges'] = []
  const add = (n: string): void => {
    if (!nodes.includes(n)) nodes.push(n)
  }
  for (const raw of body.split('\n')) {
    const line = raw.trim()
    if (!line) continue
    let label: string | undefined
    let chain = line
    const lab = line.match(/^(.*?)\s*:\s*([^:>]+)$/)
    if (lab && lab[1].includes('->')) {
      chain = lab[1]
      label = lab[2].trim()
    }
    const parts = chain
      .split(/\s*(?:->|→|=>)\s*/)
      .map((p) => p.trim())
      .filter(Boolean)
    if (parts.length === 1) {
      add(parts[0])
      continue
    }
    for (let i = 0; i < parts.length - 1; i++) {
      add(parts[i])
      add(parts[i + 1])
      edges.push({ from: parts[i], to: parts[i + 1], label: i === parts.length - 2 ? label : undefined })
    }
  }
  return nodes.length ? { nodes, edges } : null
}

export function Flow({ spec }: { spec: FlowSpec }): React.JSX.Element {
  // Layer each node by the longest path that reaches it (cycles are cut).
  const layer = new Map<string, number>()
  const depth = (n: string, seen: Set<string>): number => {
    if (layer.has(n)) return layer.get(n)!
    if (seen.has(n)) return 0
    seen.add(n)
    const parents = spec.edges.filter((e) => e.to === n).map((e) => e.from)
    const d = parents.length ? Math.max(...parents.map((p) => depth(p, seen))) + 1 : 0
    layer.set(n, d)
    return d
  }
  spec.nodes.forEach((n) => depth(n, new Set()))
  const cols: string[][] = []
  spec.nodes.forEach((n) => {
    const l = layer.get(n) ?? 0
    ;(cols[l] ??= []).push(n)
  })
  const boxW = 150
  const boxH = 42
  const gapX = 70
  const gapY = 22
  const rows = Math.max(...cols.map((c) => c.length))
  const W = cols.length * boxW + (cols.length - 1) * gapX + 20
  const H = rows * boxH + (rows - 1) * gapY + 20
  const pos = new Map<string, { x: number; y: number }>()
  cols.forEach((col, ci) => {
    const colH = col.length * boxH + (col.length - 1) * gapY
    col.forEach((n, ri) => {
      pos.set(n, { x: 10 + ci * (boxW + gapX), y: 10 + (H - 20 - colH) / 2 + ri * (boxH + gapY) })
    })
  })
  return (
    <figure className="fig fig-flow" style={{ maxWidth: Math.min(W, 720) }}>
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Diagram">
        <defs>
          <marker id="fig-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto">
            <path d="M0 0L10 5L0 10z" fill="currentColor" />
          </marker>
        </defs>
        {spec.edges.map((e, i) => {
          const a = pos.get(e.from)
          const b = pos.get(e.to)
          if (!a || !b) return null
          const forward = b.x > a.x
          const x1 = forward ? a.x + boxW : a.x + boxW / 2
          const y1 = forward ? a.y + boxH / 2 : a.y + boxH
          const x2 = forward ? b.x : b.x + boxW / 2
          const y2 = forward ? b.y + boxH / 2 : b.y
          const mx = (x1 + x2) / 2
          const d = forward
            ? `M${x1} ${y1} C ${mx} ${y1}, ${mx} ${y2}, ${x2} ${y2}`
            : `M${x1} ${y1} C ${x1} ${y1 + 30}, ${x2} ${y2 - 30}, ${x2} ${y2}`
          return (
            <g key={i}>
              <path d={d} fill="none" stroke="currentColor" strokeWidth={1.4} markerEnd="url(#fig-arrow)" opacity={0.75} />
              {e.label && (
                <text x={mx} y={(y1 + y2) / 2 - 6} textAnchor="middle" className="fig-tick">
                  {e.label}
                </text>
              )}
            </g>
          )
        })}
        {spec.nodes.map((n) => {
          const p = pos.get(n)!
          return (
            <g key={n} transform={`translate(${p.x}, ${p.y})`}>
              <rect width={boxW} height={boxH} rx={9} className="fig-box" />
              <text x={boxW / 2} y={boxH / 2 + 4} textAnchor="middle" className="fig-label">
                {n.length > 20 ? n.slice(0, 19) + '…' : n}
              </text>
            </g>
          )
        })}
      </svg>
    </figure>
  )
}
