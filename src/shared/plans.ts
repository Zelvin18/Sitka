// The plans, in one place.
//
// What each plan allows, what it costs, and how a price is shown in someone's
// own currency. The app's Settings, the website, the server's checks and the
// owners' dashboard all read this file, so a number changed here changes
// everywhere at once. Nothing here talks to a database: what plan an account
// is on comes from the `plans` table (supabase/legacy/plans.sql); this file only says
// what that plan means.

export type PlanId = 'free' | 'plus' | 'pro' | 'institution'

/** What a plan allows in a calendar month. 0 means no limit. */
export interface PlanLimits {
  /** hours of recording a month */
  hours: number
  /** how long recordings are kept, in days; 0 = for as long as the account lives */
  keepDays: number
  /** recordings kept at once, in GB */
  storageGb: number
  /** questions to Sitca a month */
  asks: number
  /** people who may follow one hosted session */
  attendees: number
}

export interface Plan {
  id: PlanId
  name: string
  /** one line under the name */
  tagline: string
  /** a month, in US dollars; 0 = free, -1 = quoted */
  usd: number
  /** the same for a student (an .edu / .ac. address); undefined = no student rate */
  usdStudent?: number
  limits: PlanLimits
  /** the lines on the plan card, in order */
  points: string[]
}

export const PLANS: Plan[] = [
  {
    id: 'free',
    name: 'Free',
    tagline: 'For trying Sitca in a class or two a month.',
    usd: 0,
    limits: { hours: 5, keepDays: 30, storageGb: 3, asks: 60, attendees: 25 },
    points: ['5 hours of recording a month', 'Recordings kept for 30 days', '60 questions to Sitca a month', 'Host up to 25 people', 'Live captions, speaker names, recap links', 'The Chrome extension']
  },
  {
    id: 'plus',
    name: 'Plus',
    tagline: 'For every lecture, every week.',
    usd: 4,
    usdStudent: 2,
    limits: { hours: 40, keepDays: 365, storageGb: 30, asks: 600, attendees: 150 },
    points: ['40 hours of recording a month', 'Recordings kept for a year', '600 questions to Sitca a month', 'Host up to 150 people', 'Everything in Free']
  },
  {
    id: 'pro',
    name: 'Pro',
    tagline: 'For people who teach, present or run meetings for a living.',
    usd: 10,
    limits: { hours: 150, keepDays: 0, storageGb: 150, asks: 0, attendees: 500 },
    points: ['150 hours of recording a month', 'Recordings kept for good', 'Unlimited questions to Sitca', 'Host up to 500 people', 'Everything in Plus']
  },
  {
    id: 'institution',
    name: 'Institution',
    tagline: 'For a school, a university or a company: every seat, one library.',
    usd: -1,
    limits: { hours: 0, keepDays: 0, storageGb: 0, asks: 0, attendees: 2000 },
    points: ['Unlimited recording, pooled across seats', 'A shared library and spaces for the whole organisation', 'Host up to 2,000 people', 'An administrator, and help when you need it', 'Everything in Pro']
  }
]

export function planOf(id: string | null | undefined): Plan {
  return PLANS.find((p) => p.id === id) ?? PLANS[0]
}

/** A student, for the student rate: an academic address. */
export function isStudentEmail(email: string | undefined): boolean {
  const e = (email || '').toLowerCase()
  return /\.(edu|ac\.[a-z]{2}|edu\.[a-z]{2})$/.test(e) || /\.(ac|edu)\.[a-z]{2}$/.test(e)
}

// ---------- money ----------

export interface Currency {
  code: string
  name: string
  /** how many of it one US dollar buys (a working rate, not a market feed) */
  perUsd: number
  /** prices are rounded to a multiple of this, so they read as prices do locally */
  step: number
  /** shown before the number */
  symbol: string
  /** decimals to show */
  decimals: number
}

export const CURRENCIES: Currency[] = [
  { code: 'UGX', name: 'Ugandan shilling', perUsd: 3700, step: 500, symbol: 'UGX ', decimals: 0 },
  { code: 'USD', name: 'US dollar', perUsd: 1, step: 0.5, symbol: '$', decimals: 0 },
  { code: 'KES', name: 'Kenyan shilling', perUsd: 129, step: 10, symbol: 'KSh ', decimals: 0 },
  { code: 'TZS', name: 'Tanzanian shilling', perUsd: 2600, step: 500, symbol: 'TSh ', decimals: 0 },
  { code: 'RWF', name: 'Rwandan franc', perUsd: 1420, step: 100, symbol: 'RF ', decimals: 0 },
  { code: 'ZAR', name: 'South African rand', perUsd: 18, step: 5, symbol: 'R', decimals: 0 },
  { code: 'NGN', name: 'Nigerian naira', perUsd: 1550, step: 500, symbol: '₦', decimals: 0 },
  { code: 'GHS', name: 'Ghanaian cedi', perUsd: 15.5, step: 5, symbol: 'GH₵', decimals: 0 },
  { code: 'ZMW', name: 'Zambian kwacha', perUsd: 26, step: 5, symbol: 'K', decimals: 0 },
  { code: 'GBP', name: 'British pound', perUsd: 0.78, step: 0.5, symbol: '£', decimals: 0 },
  { code: 'EUR', name: 'Euro', perUsd: 0.92, step: 0.5, symbol: '€', decimals: 0 }
]

/** Prices set by hand in a currency, where the rounded conversion would read oddly. */
const FIXED: Record<string, Record<PlanId, number | undefined>> = {
  UGX: { free: 0, plus: 15000, pro: 38000, institution: undefined }
}
const FIXED_STUDENT: Record<string, Partial<Record<PlanId, number>>> = {
  UGX: { plus: 8000 }
}

export const DEFAULT_CURRENCY = 'UGX'

export function currencyOf(code: string | null | undefined): Currency {
  return CURRENCIES.find((c) => c.code === code) ?? CURRENCIES[0]
}

/** A plan's monthly price in a currency, as a number; null when quoted. */
export function priceIn(plan: Plan, code: string, student = false): number | null {
  const asStudent = student && plan.usdStudent !== undefined
  const usd = asStudent ? (plan.usdStudent as number) : plan.usd
  if (usd < 0) return null
  if (usd === 0) return 0
  const fixed = asStudent ? FIXED_STUDENT[code]?.[plan.id] : FIXED[code]?.[plan.id]
  if (typeof fixed === 'number') return fixed
  const c = currencyOf(code)
  const raw = usd * c.perUsd
  return Math.max(c.step, Math.round(raw / c.step) * c.step)
}

/** "UGX 15,000", "$4", "Free", "Let's talk" */
export function formatPrice(plan: Plan, code: string, student = false): string {
  const n = priceIn(plan, code, student)
  if (n === null) return 'Let’s talk'
  if (n === 0) return 'Free'
  return formatMoney(n, code)
}

export function formatMoney(n: number, code: string): string {
  const c = currencyOf(code)
  const num = n.toLocaleString(undefined, { minimumFractionDigits: c.decimals, maximumFractionDigits: c.decimals })
  return `${c.symbol}${num}`
}

/** A year at ten months' price: two months free. */
export function yearlyPrice(plan: Plan, code: string, student = false): number | null {
  const m = priceIn(plan, code, student)
  return m === null ? null : m * 10
}

// ---------- usage against a plan ----------

/** What an account has used this period, as the database reports it. */
export interface Usage {
  plan: PlanId
  /** when the paid plan ends (renewal date); undefined on Free */
  planEnds?: string
  /** who set the plan: 'manual' for now, a payment provider later */
  planSource?: string
  periodStart: string
  periodEnd: string
  hours: number
  asks: number
  sessions: number
  /** the most people in one hosted session this period */
  attendeesMax: number
  /** bytes of recordings kept, when known */
  storageBytes?: number
}

export type Meter = 'hours' | 'asks' | 'storage'

/** The share of a limit used, 0..1; 0 when the plan has no such limit. */
export function usedShare(usage: Usage, meter: Meter): number {
  const lim = planOf(usage.plan).limits
  if (meter === 'hours') return lim.hours ? Math.min(1, usage.hours / lim.hours) : 0
  if (meter === 'asks') return lim.asks ? Math.min(1, usage.asks / lim.asks) : 0
  const gb = (usage.storageBytes ?? 0) / 1073741824
  return lim.storageGb ? Math.min(1, gb / lim.storageGb) : 0
}

/** Is the account over a limit? Unlimited never is. */
export function overLimit(usage: Usage, meter: Meter): boolean {
  const lim = planOf(usage.plan).limits
  if (meter === 'hours') return lim.hours > 0 && usage.hours >= lim.hours
  if (meter === 'asks') return lim.asks > 0 && usage.asks >= lim.asks
  return lim.storageGb > 0 && (usage.storageBytes ?? 0) / 1073741824 >= lim.storageGb
}

/** The words the app says when a limit is reached. */
export function limitMessage(usage: Usage, meter: Meter): string {
  const p = planOf(usage.plan)
  const upgrade = p.id === 'free' ? 'Plus gives you 40 hours, 600 questions and a year of storage.' : p.id === 'plus' ? 'Pro gives you 150 hours, unlimited questions and recordings kept for good.' : 'Talk to us about more.'
  if (meter === 'hours') return `You’ve used your ${p.limits.hours} hours of recording for this month. ${upgrade}`
  if (meter === 'asks') return `You’ve asked Sitca ${p.limits.asks} questions this month, the ${p.name} plan’s share. ${upgrade}`
  return `Your recordings fill the ${p.limits.storageGb} GB the ${p.name} plan keeps. Delete a session you no longer need, or move up. ${upgrade}`
}

/** "resets 1 Oct" */
export function periodResetLabel(usage: Usage): string {
  const d = new Date(usage.periodEnd)
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })
}
