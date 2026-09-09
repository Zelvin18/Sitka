import React from 'react'

/**
 * Readable maths without a maths library. The models are asked to write
 * plain notation, but whatever arrives — x^2, \frac{a}{b}, \sqrt{x}, Greek
 * letters, $…$ or \( … \) delimiters — is turned into stacked fractions,
 * real superscripts and subscripts, and proper symbols.
 */

const SYMBOLS: Record<string, string> = {
  cdot: '·',
  times: '×',
  div: '÷',
  le: '≤',
  leq: '≤',
  ge: '≥',
  geq: '≥',
  ne: '≠',
  neq: '≠',
  pm: '±',
  mp: '∓',
  infty: '∞',
  to: '→',
  rightarrow: '→',
  Rightarrow: '⇒',
  leftarrow: '←',
  approx: '≈',
  equiv: '≡',
  propto: '∝',
  pi: 'π',
  theta: 'θ',
  alpha: 'α',
  beta: 'β',
  gamma: 'γ',
  delta: 'δ',
  Delta: 'Δ',
  lambda: 'λ',
  mu: 'μ',
  nu: 'ν',
  sigma: 'σ',
  Sigma: 'Σ',
  omega: 'ω',
  Omega: 'Ω',
  epsilon: 'ε',
  varepsilon: 'ε',
  phi: 'φ',
  varphi: 'φ',
  rho: 'ρ',
  tau: 'τ',
  eta: 'η',
  kappa: 'κ',
  chi: 'χ',
  psi: 'ψ',
  xi: 'ξ',
  zeta: 'ζ',
  int: '∫',
  sum: '∑',
  prod: '∏',
  partial: '∂',
  nabla: '∇',
  in: '∈',
  notin: '∉',
  subset: '⊂',
  cup: '∪',
  cap: '∩',
  forall: '∀',
  exists: '∃',
  angle: '∠',
  degree: '°',
  circ: '°',
  ln: 'ln',
  log: 'log',
  exp: 'exp',
  sin: 'sin',
  cos: 'cos',
  tan: 'tan',
  sec: 'sec',
  csc: 'csc',
  cot: 'cot',
  arcsin: 'arcsin',
  arccos: 'arccos',
  arctan: 'arctan',
  lim: 'lim',
  max: 'max',
  min: 'min',
  dots: '…',
  ldots: '…',
  cdots: '⋯',
  quad: '  ',
  qquad: '    ',
  left: '',
  right: '',
  displaystyle: '',
  ',': ' ',
  ';': ' ',
  '!': ''
}

// One token of interest: a fraction, a root, a power, an index, a \command, a \text{}.
const TOKEN_RE =
  /\\(?:text|mathrm|mathbf|operatorname)\{([^{}]*)\}|\\frac\{([^{}]*)\}\{([^{}]*)\}|\\sqrt\{([^{}]*)\}|\^\{([^{}]*)\}|\^(\([^()]*\)|[A-Za-z0-9]+)|_\{([^{}]*)\}|(?<=[A-Za-z0-9)\]])_([A-Za-z0-9])(?![A-Za-z0-9_])|\\([A-Za-z]+|[,;!])/g

/** Convert one run of maths-ish text into React nodes. */
export function mathify(text: string, keyPrefix: string): React.ReactNode[] {
  const nodes: React.ReactNode[] = []
  let last = 0
  let i = 0
  for (const m of text.matchAll(TOKEN_RE)) {
    const idx = m.index ?? 0
    if (idx > last) nodes.push(text.slice(last, idx))
    const k = `${keyPrefix}-m${i++}`
    if (m[1] !== undefined) {
      nodes.push(m[1])
    } else if (m[2] !== undefined) {
      nodes.push(
        <span key={k} className="frac">
          <span>{mathify(m[2], k)}</span>
          <span>{mathify(m[3], k + 'd')}</span>
        </span>
      )
    } else if (m[4] !== undefined) {
      nodes.push(
        <React.Fragment key={k}>
          √<span className="sqrt">{mathify(m[4], k)}</span>
        </React.Fragment>
      )
    } else if (m[5] !== undefined || m[6] !== undefined) {
      const raw = m[5] ?? m[6]
      const inner = raw.startsWith('(') && raw.endsWith(')') && m[5] === undefined ? raw.slice(1, -1) : raw
      nodes.push(<sup key={k}>{mathify(inner, k)}</sup>)
    } else if (m[7] !== undefined || m[8] !== undefined) {
      nodes.push(<sub key={k}>{mathify(m[7] ?? m[8], k)}</sub>)
    } else if (m[9] !== undefined) {
      const sym = SYMBOLS[m[9]]
      nodes.push(sym !== undefined ? sym : m[9])
    }
    last = idx + m[0].length
  }
  if (last < text.length) nodes.push(text.slice(last))
  return nodes
}

// Delimited maths: $$…$$ or \[…\] (displayed on its own line), $…$ or \(…\) (inline).
const DELIM_RE = /(\$\$[^$]+\$\$|\\\[[\s\S]+?\\\]|\$(?=\S)[^$\n]+?(?<=\S)\$|\\\([\s\S]+?\\\))/g

/**
 * Plain prose with maths in it: delimited runs become styled maths, and bare
 * notation (x^2, \frac, Greek commands) is converted wherever it appears.
 */
export function renderMath(text: string, keyPrefix: string): React.ReactNode[] {
  if (!/[\\^_$]/.test(text)) return [text]
  const out: React.ReactNode[] = []
  text.split(DELIM_RE).forEach((part, i) => {
    if (!part) return
    const k = `${keyPrefix}-x${i}`
    if (part.startsWith('$$') || part.startsWith('\\[')) {
      out.push(
        <span key={k} className="math math-block">
          {mathify(part.slice(2, -2).trim(), k)}
        </span>
      )
    } else if (part.startsWith('\\(') || (part.startsWith('$') && part.length > 2)) {
      out.push(
        <span key={k} className="math">
          {mathify(part.startsWith('$') ? part.slice(1, -1) : part.slice(2, -2), k)}
        </span>
      )
    } else {
      out.push(...mathify(part, k))
    }
  })
  return out
}
