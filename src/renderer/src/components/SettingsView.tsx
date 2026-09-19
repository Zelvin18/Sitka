import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import type { Profile, Settings } from '@shared/types'
import {
  CURRENCIES,
  DEFAULT_CURRENCY,
  PLANS,
  formatMoney,
  formatPrice,
  isStudentEmail,
  periodResetLabel,
  planOf,
  priceIn,
  usedShare,
  type Plan,
  type Usage
} from '@shared/plans'
import Tour from './Tour'
import ConfirmDialog from './ConfirmDialog'
import { IconBack, IconChevron, IconPlay, Mark } from '../lib/icons'
import { applyAppearance } from '../lib/prefs'

interface Props {
  settings: Settings | null
  onSaved: (s: Settings) => void
  /** opens a session (used by the sample lecture) */
  onOpenSession?: (id: string) => void
}

const isWeb = (window as unknown as { sitkaWeb?: boolean }).sitkaWeb === true
const inExtension = Boolean((window as unknown as { sitkaExt?: unknown }).sitkaExt)
const CAN_SHARE_SCREEN = typeof navigator.mediaDevices?.getDisplayMedia === 'function'
const SITE = 'https://sitcaai.vercel.app'
const WHATSAPP = '256759055133'
const MAIL = 'magumisekelvin8@gmail.com'

const LANGUAGES = [
  ['', 'Same as I write'],
  ['English', 'English'],
  ['Shona', 'Shona'],
  ['Ndebele', 'Ndebele'],
  ['Nyankole', 'Nyankole'],
  ['Luganda', 'Luganda'],
  ['Swahili', 'Swahili'],
  ['French', 'French'],
  ['Portuguese', 'Portuguese'],
  ['Spanish', 'Spanish'],
  ['Arabic', 'Arabic'],
  ['Chinese', 'Chinese']
] as const

// ---------- the pages ----------

type SectionId = 'account' | 'plan' | 'preferences' | 'sessions' | 'data' | 'providers' | 'help'

interface Section {
  id: SectionId
  title: string
  /** one line under the title on the phone's list */
  blurb: string
  /** words a search may find it by */
  keys: string
  group: 'account' | 'app' | 'help'
  icon: React.ReactNode
}

const ic = (d: React.ReactNode): React.ReactNode => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {d}
  </svg>
)

const SECTIONS: Section[] = [
  { id: 'account', title: 'Account', blurb: 'Your name, your email, signing out', keys: 'name email sign out profile', group: 'account', icon: ic(<><circle cx="12" cy="8" r="4" /><path d="M4 21a8 8 0 0 1 16 0" /></>) },
  { id: 'plan', title: 'Plan & usage', blurb: 'What you have used this month, and the plans', keys: 'plan usage upgrade price billing hours storage questions free plus pro', group: 'account', icon: ic(<><rect x="3" y="5" width="18" height="14" rx="3" /><path d="M3 10h18M7 15h3" /></>) },
  { id: 'preferences', title: 'Preferences', blurb: 'Appearance, text size, language, currency', keys: 'theme dark light text size language currency appearance', group: 'app', icon: ic(<><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" /></>) },
  { id: 'sessions', title: 'Sessions', blurb: 'What a new session watches, reads and notes', keys: 'session capture screen camera audio read notes microphone', group: 'app', icon: ic(<><rect x="9" y="3" width="6" height="11" rx="3" /><path d="M5 11a7 7 0 0 0 14 0M12 18v3" /></>) },
  { id: 'data', title: 'Data & privacy', blurb: 'Where things live, how long, and deleting', keys: 'privacy data delete account recordings storage retention terms', group: 'app', icon: ic(<><path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z" /><path d="M9 12l2 2 4-4" /></>) },
  { id: 'providers', title: 'AI providers', blurb: 'Use your own keys instead of Sitca’s', keys: 'api key groq anthropic openai provider supabase', group: 'app', icon: ic(<><path d="M12 3l2.4 5.2L20 9l-4 3.9.9 5.6L12 15.8 7.1 18.5 8 12.9 4 9l5.6-.8z" /></>) },
  { id: 'help', title: 'Help & contact', blurb: 'The walkthrough, Sitca for Chrome, talk to us', keys: 'help contact whatsapp email tour walkthrough chrome extension about version', group: 'help', icon: ic(<><circle cx="12" cy="12" r="9" /><path d="M9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.7.3-1 .8-1 1.5M12 17h.01" /></>) }
]

const GROUPS: { id: Section['group']; title: string }[] = [
  { id: 'account', title: 'You' },
  { id: 'app', title: 'Sitca' },
  { id: 'help', title: 'Help' }
]

// ---------- small parts ----------

function Segmented<T extends string>({
  value,
  options,
  onChange
}: {
  value: T
  options: readonly (readonly [T, string])[]
  onChange: (v: T) => void
}): React.JSX.Element {
  return (
    <div className="seg-choice" role="radiogroup">
      {options.map(([v, label]) => (
        <button key={v} role="radio" aria-checked={value === v} className={value === v ? 'on' : ''} onClick={() => onChange(v)}>
          {label}
        </button>
      ))}
    </div>
  )
}

function Toggle({ on, onChange, label }: { on: boolean; onChange: (v: boolean) => void; label: string }): React.JSX.Element {
  return <button className={`toggle${on ? ' on' : ''}`} role="switch" aria-checked={on} aria-label={label} onClick={() => onChange(!on)} />
}

function Row({ title, desc, children, wrap }: { title: string; desc?: React.ReactNode; children?: React.ReactNode; wrap?: boolean }): React.JSX.Element {
  return (
    <div className={`set-row${wrap ? ' wrap' : ''}`}>
      <div className="set-text">
        <div className="set-title">{title}</div>
        {desc && <div className="set-desc">{desc}</div>}
      </div>
      {children}
    </div>
  )
}

function Meter({ label, used, limit, unit, share }: { label: string; used: string; limit: string; unit?: string; share: number }): React.JSX.Element {
  const hot = share >= 0.8
  return (
    <div className={`stg-meter${hot ? ' hot' : ''}`}>
      <div className="stg-meter-head">
        <span>{label}</span>
        <span className="stg-meter-nums">
          <b>{used}</b>
          {limit ? ` / ${limit}` : ''}
          {unit ? ` ${unit}` : ''}
        </span>
      </div>
      <div className="stg-meter-bar">
        <i style={{ width: `${Math.round(Math.max(limit ? 2 : 0, share * 100))}%` }} />
      </div>
    </div>
  )
}

const fmtGb = (bytes: number): string => {
  const gb = bytes / 1073741824
  return gb >= 10 ? gb.toFixed(0) : gb >= 1 ? gb.toFixed(1) : (bytes / 1048576).toFixed(0) + ' MB'
}

// ---------- the view ----------

export default function SettingsView({ settings, onSaved }: Props): React.JSX.Element {
  const [showTour, setShowTour] = useState(false)
  const closeTour = useCallback(() => setShowTour(false), [])
  const [profile, setProfile] = useState<Profile | null>(null)
  const [confirmSignOut, setConfirmSignOut] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [showKeys, setShowKeys] = useState(false)
  const [usage, setUsage] = useState<Usage | null | undefined>(undefined)
  const [choosing, setChoosing] = useState<Plan | null>(null)
  const [yearly, setYearly] = useState(false)
  const [query, setQuery] = useState('')

  // one page at a time on a wide screen; the list first on a phone
  const narrow = useMedia('(max-width: 860px)')
  const [section, setSection] = useState<SectionId | null>(() => (window.innerWidth <= 860 ? null : 'account'))
  useEffect(() => {
    if (!narrow && section === null) setSection('account')
  }, [narrow, section])

  const [anthropicKey, setAnthropicKey] = useState('')
  const [openaiKey, setOpenaiKey] = useState('')
  const [groqKey, setGroqKey] = useState('')
  const [supaUrl, setSupaUrl] = useState('')
  const [supaKey, setSupaKey] = useState('')
  const [webUrl, setWebUrl] = useState('')
  const [saved, setSaved] = useState(false)

  useEffect(() => {
    void window.sitka.getProfile().then(setProfile)
    const onProfile = (e: Event): void => setProfile((e as CustomEvent<Profile>).detail)
    window.addEventListener('sitka:profile', onProfile)
    return () => window.removeEventListener('sitka:profile', onProfile)
  }, [])
  useEffect(() => {
    let gone = false
    void window.sitka
      .getUsage()
      .then((u) => {
        if (!gone) setUsage(u)
      })
      .catch(() => {
        if (!gone) setUsage(null)
      })
    return () => {
      gone = true
    }
  }, [])

  const [nameDraft, setNameDraft] = useState<string | null>(null)
  const saveName = async (): Promise<void> => {
    const clean = (nameDraft ?? '').trim()
    if (!clean) return
    const p = await window.sitka.setProfileName(clean).catch(() => null)
    if (p) {
      setProfile(p)
      setNameDraft(null)
      window.dispatchEvent(new CustomEvent('sitka:profile', { detail: p }))
    }
  }

  useEffect(() => {
    if (settings) {
      setAnthropicKey(settings.anthropicApiKey)
      setOpenaiKey(settings.openaiApiKey)
      setGroqKey(settings.groqApiKey)
      setSupaUrl(settings.supabaseUrl ?? '')
      setSupaKey(settings.supabaseServiceKey ?? '')
      setWebUrl(settings.webAppUrl ?? '')
      const own = Boolean(settings.anthropicApiKey || settings.openaiApiKey || settings.groqApiKey)
      if (own) setShowKeys(true)
    }
  }, [settings])

  const base = (): Settings =>
    settings ?? {
      anthropicApiKey: '',
      openaiApiKey: '',
      groqApiKey: '',
      supabaseUrl: '',
      supabaseServiceKey: '',
      webAppUrl: ''
    }

  /** Preferences save the moment they change; there is nothing to press. */
  const persist = async (patch: Partial<Settings>): Promise<void> => {
    const next: Settings = { ...base(), ...patch }
    await window.sitka.setSettings(next)
    onSaved(next)
    applyAppearance(next.theme, next.textSize)
  }

  /** Keys save with the button, so a half-typed key is never used. */
  const saveKeys = async (): Promise<void> => {
    const next: Settings = {
      ...base(),
      anthropicApiKey: anthropicKey.trim(),
      openaiApiKey: openaiKey.trim(),
      groqApiKey: groqKey.trim(),
      supabaseUrl: supaUrl.trim().replace(/\/+$/, ''),
      supabaseServiceKey: supaKey.trim(),
      webAppUrl: webUrl.trim().replace(/\/+$/, '')
    }
    await window.sitka.setSettings(next)
    onSaved(next)
    setSaved(true)
    setTimeout(() => setSaved(false), 2000)
  }

  const theme = settings?.theme ?? 'system'
  const textSize = settings?.textSize ?? 'normal'
  const answerLanguage = settings?.answerLanguage ?? ''
  const currency = settings?.currency || DEFAULT_CURRENCY
  const notes = settings?.notes !== false
  const readScreen = settings?.readScreen !== false
  const defaultCapture = settings?.defaultCapture ?? (CAN_SHARE_SCREEN ? 'screen' : 'camera')
  const initials = (profile?.name || 'You')
    .split(/\s+/)
    .map((w) => w[0])
    .join('')
    .slice(0, 2)
    .toUpperCase()
  const plan = planOf(usage?.plan)
  const student = isStudentEmail(profile?.email)
  const hasPlan = profile?.cloud === true && usage !== null

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase()
    return SECTIONS.filter((s) => {
      if (s.id === 'plan' && profile?.cloud === false) return false
      if (s.id === 'providers' && inExtension) return false
      if (!q) return true
      return `${s.title} ${s.blurb} ${s.keys}`.toLowerCase().includes(q)
    })
  }, [query, profile?.cloud])

  const open = (id: SectionId): void => {
    setSection(id)
    setQuery('')
  }
  const current = SECTIONS.find((s) => s.id === section) ?? null

  // ---------- pages ----------

  const accountPage = (
    <>
      <div className="card stg-hero">
        <div className="set-account">
          <div className="set-avatar stg-avatar">{initials}</div>
          <div className="set-text">
            <div className="set-account-name">{profile?.name ?? 'You'}</div>
            <div className="set-account-mail">{profile?.email ?? (profile?.cloud ? 'Online workspace' : 'Local workspace on this computer')}</div>
          </div>
          {hasPlan && (
            <span className={`stg-plan-pill${plan.id === 'free' ? '' : ' paid'}`}>{plan.name}</span>
          )}
        </div>
      </div>
      {hasPlan && plan.id === 'free' && (
        <button className="stg-upgrade" onClick={() => open('plan')}>
          <span className="stg-upgrade-mark">
            <Mark size={18} />
          </span>
          <span className="stg-upgrade-text">
            <b>Do more with Sitca</b>
            <span>More hours, more questions, and recordings kept for a year.</span>
          </span>
          <span className="stg-upgrade-btn">See plans</span>
        </button>
      )}
      <div className="card">
        <Row title="Your name" desc="What Sitca calls you — on screen, and in a kind word now and then." wrap>
          {nameDraft === null ? (
            <button className="btn btn-ghost btn-sm" onClick={() => setNameDraft(profile?.needsName ? '' : (profile?.name ?? ''))}>
              {profile?.needsName ? 'Add your name' : 'Change'}
            </button>
          ) : (
            <div className="set-name-edit">
              <input
                className="input"
                value={nameDraft}
                maxLength={80}
                autoFocus
                placeholder="Your name"
                onChange={(e) => setNameDraft(e.currentTarget.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void saveName()
                  if (e.key === 'Escape') setNameDraft(null)
                }}
              />
              <button className="btn btn-sm" disabled={!nameDraft.trim()} onClick={() => void saveName()}>
                Save
              </button>
              <button className="btn btn-ghost btn-sm" onClick={() => setNameDraft(null)}>
                Cancel
              </button>
            </div>
          )}
        </Row>
        {profile?.email && <Row title="Email" desc={profile.email} />}
        {hasPlan && (
          <Row title="Plan" desc={usage?.planEnds ? `${plan.name}, until ${new Date(usage.planEnds).toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' })}` : plan.name}>
            <button className="btn btn-ghost btn-sm" onClick={() => open('plan')}>
              {plan.id === 'free' ? 'See plans' : 'Manage'}
            </button>
          </Row>
        )}
        {profile?.cloud && (
          <Row title="Sign out" desc="Your sessions stay safely in your workspace. Sign back in any time.">
            <button className="btn btn-ghost btn-sm" onClick={() => setConfirmSignOut(true)}>
              Sign out
            </button>
          </Row>
        )}
      </div>
    </>
  )

  const planPage = (
    <>
      {usage === undefined ? (
        <div className="card stg-wait">Reading your month…</div>
      ) : !usage ? (
        <div className="card stg-wait">Your usage could not be read just now. The plans are below.</div>
      ) : (
        <div className="card stg-usage">
          <div className="stg-usage-head">
            <div>
              <div className="stg-usage-plan">
                {plan.name}
                <span className={`stg-plan-pill${plan.id === 'free' ? '' : ' paid'}`}>{plan.id === 'free' ? 'Current' : 'Active'}</span>
              </div>
              <div className="set-desc">
                {plan.tagline}
                {usage.planEnds ? ` Renews ${new Date(usage.planEnds).toLocaleDateString(undefined, { day: 'numeric', month: 'long' })}.` : ''}
              </div>
            </div>
            <div className="stg-usage-reset">Resets {periodResetLabel(usage)}</div>
          </div>
          <div className="stg-meters">
            <Meter label="Recording" used={usage.hours >= 10 ? usage.hours.toFixed(0) : usage.hours.toFixed(1)} limit={plan.limits.hours ? String(plan.limits.hours) : ''} unit="hours" share={usedShare(usage, 'hours')} />
            <Meter label="Questions to Sitca" used={String(usage.asks)} limit={plan.limits.asks ? String(plan.limits.asks) : ''} unit={plan.limits.asks ? '' : 'unlimited'} share={usedShare(usage, 'asks')} />
            <Meter label="Recordings kept" used={usage.storageBytes === undefined ? '—' : fmtGb(usage.storageBytes)} limit={plan.limits.storageGb ? String(plan.limits.storageGb) : ''} unit={usage.storageBytes !== undefined && usage.storageBytes < 1073741824 ? '' : 'GB'} share={usedShare(usage, 'storage')} />
            <Meter label="Biggest room this month" used={String(usage.attendeesMax)} limit={String(plan.limits.attendees)} unit="people" share={plan.limits.attendees ? Math.min(1, usage.attendeesMax / plan.limits.attendees) : 0} />
          </div>
          <div className="set-desc stg-usage-note">
            {usage.sessions} session{usage.sessions === 1 ? '' : 's'} this month. A session already running is never cut off; the limits only decide whether the next one starts.
          </div>
        </div>
      )}

      <div className="stg-plans-head">
        <div>
          <div className="stg-plans-title">Plans</div>
          <div className="set-desc">{student ? 'Your address is a student one: the student rate applies to Plus.' : 'Prices a month. Students with a university address pay less for Plus.'}</div>
        </div>
        <div className="stg-plans-tools">
          <div className="seg-choice">
            <button className={yearly ? '' : 'on'} onClick={() => setYearly(false)}>
              Monthly
            </button>
            <button className={yearly ? 'on' : ''} onClick={() => setYearly(true)}>
              Yearly <small>2 months free</small>
            </button>
          </div>
          <select className="set-select stg-currency" value={currency} onChange={(e) => void persist({ currency: e.target.value })} aria-label="Currency">
            {CURRENCIES.map((c) => (
              <option key={c.code} value={c.code}>
                {c.code}
              </option>
            ))}
          </select>
        </div>
      </div>
      <div className="stg-plans">
        {PLANS.map((p) => {
          const isCurrent = hasPlan && p.id === plan.id
          const monthly = priceIn(p, currency, student)
          const shown = monthly === null ? 'Let’s talk' : monthly === 0 ? 'Free' : yearly ? formatMoney(monthly * 10, currency) : formatMoney(monthly, currency)
          const per = monthly === null || monthly === 0 ? '' : yearly ? ' a year' : ' a month'
          return (
            <div key={p.id} className={`stg-plan${isCurrent ? ' current' : ''}${p.id === 'plus' ? ' star' : ''}`}>
              {p.id === 'plus' && <span className="stg-plan-tag">Most chosen</span>}
              <div className="stg-plan-name">{p.name}</div>
              <div className="stg-plan-price">
                {shown}
                <small>{per}</small>
              </div>
              {student && p.usdStudent !== undefined && <div className="stg-plan-student">Student rate · usually {formatPrice(p, currency)}</div>}
              <div className="stg-plan-tagline">{p.tagline}</div>
              <ul className="stg-plan-points">
                {p.points.map((pt) => (
                  <li key={pt}>{pt}</li>
                ))}
              </ul>
              {isCurrent ? (
                <button className="btn btn-ghost btn-sm stg-plan-btn" disabled>
                  Your plan
                </button>
              ) : p.id === 'free' ? (
                <button className="btn btn-ghost btn-sm stg-plan-btn" onClick={() => setChoosing(p)}>
                  Move to Free
                </button>
              ) : (
                <button className={`btn btn-sm stg-plan-btn${p.id === 'plus' ? ' btn-primary' : ''}`} onClick={() => setChoosing(p)}>
                  {p.usd < 0 ? 'Talk to us' : `Choose ${p.name}`}
                </button>
              )}
            </div>
          )
        })}
      </div>
      <div className="set-desc stg-plans-foot">
        Prices in {currency} are a guide from the US dollar price; the amount you pay is confirmed before anything is charged. Change the currency in Preferences.
      </div>
    </>
  )

  const preferencesPage = (
    <>
      <div className="section-title stg-first">Appearance</div>
      <div className="card">
        <Row title="Theme" desc="Follow your device, or keep Sitca light or dark." wrap>
          <Segmented
            value={theme}
            options={[
              ['system', 'System'],
              ['light', 'Light'],
              ['dark', 'Dark']
            ]}
            onChange={(v) => void persist({ theme: v })}
          />
        </Row>
        <Row title="Text size" desc="Larger text everywhere in the app." wrap>
          <Segmented
            value={textSize}
            options={[
              ['normal', 'Normal'],
              ['large', 'Large']
            ]}
            onChange={(v) => void persist({ textSize: v })}
          />
        </Row>
      </div>
      <div className="section-title">Language & money</div>
      <div className="card">
        <Row title="Answer in" desc="The language Sitca replies in, whatever language the session is in." wrap>
          <select className="set-select" value={answerLanguage} onChange={(e) => void persist({ answerLanguage: e.target.value })}>
            {LANGUAGES.map(([v, label]) => (
              <option key={v} value={v}>
                {label}
              </option>
            ))}
          </select>
        </Row>
        <Row title="Currency" desc="How plan prices are shown to you." wrap>
          <select className="set-select" value={currency} onChange={(e) => void persist({ currency: e.target.value })}>
            {CURRENCIES.map((c) => (
              <option key={c.code} value={c.code}>
                {c.code} · {c.name}
              </option>
            ))}
          </select>
        </Row>
      </div>
    </>
  )

  const sessionsPage = (
    <div className="card">
      <Row title="What a new session watches" desc="You can still change it on the setup page each time." wrap>
        <Segmented
          value={defaultCapture}
          options={
            CAN_SHARE_SCREEN
              ? [
                  ['screen', 'Screen'],
                  ['camera', 'Camera'],
                  ['audio', 'Audio']
                ]
              : [
                  ['camera', 'Camera'],
                  ['audio', 'Audio']
                ]
          }
          onChange={(v) => void persist({ defaultCapture: v })}
        />
      </Row>
      <Row title="Read the screen" desc="Sitca reads slides, the board and charts whenever the picture settles on something new.">
        <Toggle on={readScreen} onChange={(v) => void persist({ readScreen: v })} label="Read the screen" />
      </Row>
      <Row title="Notes from Sitca" desc="Short notes in the chat when Sitca notices something worth your attention.">
        <Toggle on={notes} onChange={(v) => void persist({ notes: v })} label="Notes from Sitca" />
      </Row>
    </div>
  )

  const dataPage = (
    <>
      <div className="card">
        <Row title="Where your recordings live" desc="In Sitca’s own storage, under your account alone. Nobody else can open a recording unless you share its recap link or host it." />
        <Row
          title="How long they are kept"
          desc={
            hasPlan
              ? plan.limits.keepDays
                ? `${plan.limits.keepDays === 365 ? 'A year' : `${plan.limits.keepDays} days`} on the ${plan.name} plan. Transcripts, notes and highlights stay after the recording goes.`
                : `For as long as your account lives, on the ${plan.name} plan.`
              : 'On this computer, for as long as you keep them.'
          }
        />
        <Row title="What Sitca learns from" desc="Only what was said and shown in your sessions, to answer you. Your recordings never train anyone’s models." />
        <Row title="Privacy & Terms" desc="The full words, in plain language.">
          <a className="btn btn-ghost btn-sm" href={isWeb ? '/legal' : `${SITE}/legal`} target="_blank" rel="noreferrer">
            Read
          </a>
        </Row>
      </div>
      {profile?.cloud && (
        <>
          <div className="section-title">Leaving Sitca</div>
          <div className="card">
            <div className="set-row wrap">
              <div className="set-text">
                <div className="set-title">Delete my account</div>
                <div className="set-desc">
                  Every session, recording, note and document you made, and the account itself, are removed for good. Organisations you created are removed for everyone in them. This cannot be undone.
                </div>
              </div>
              <button className="btn btn-ghost btn-sm set-delete-account" onClick={() => setDeleting(true)}>
                Delete account…
              </button>
            </div>
          </div>
        </>
      )}
    </>
  )

  const providersPage = (
    <>
      <div className="card">
        <div className="set-keys-note">
          {isWeb
            ? 'Sitca comes with its AI included. Add your own keys only if you want to use your own accounts; they stay in this browser and are sent straight to each provider.'
            : 'Your keys are stored only on this computer and are used only to call each provider directly.'}
        </div>
        {!showKeys ? (
          <button className="btn btn-ghost btn-sm" onClick={() => setShowKeys(true)}>
            Use my own keys
          </button>
        ) : (
          <>
            <div className="field">
              <label className="field-label">Groq API key</label>
              <input className="input" type="password" placeholder="gsk_…" value={groqKey} onChange={(e) => setGroqKey(e.target.value)} autoCorrect="off" spellCheck={false} />
              <div className="field-hint">One free key covers transcription and answers. Create it at console.groq.com — no card required.</div>
            </div>
            <div className="field">
              <label className="field-label">Anthropic API key</label>
              <input className="input" type="password" placeholder="sk-ant-…" value={anthropicKey} onChange={(e) => setAnthropicKey(e.target.value)} autoCorrect="off" spellCheck={false} />
              <div className="field-hint">The highest quality answers and the most reliable reading of the screen. Preferred whenever present.</div>
            </div>
            <div className="field" style={{ marginBottom: 0 }}>
              <label className="field-label">OpenAI API key</label>
              <input className="input" type="password" placeholder="sk-…" value={openaiKey} onChange={(e) => setOpenaiKey(e.target.value)} autoCorrect="off" spellCheck={false} />
              <div className="field-hint">Live transcription with Whisper. Preferred over Groq when present.</div>
            </div>
          </>
        )}
      </div>

      {!isWeb && (
        <>
          <div className="section-title">Online events</div>
          <div className="card">
            <div className="field">
              <label className="field-label">Supabase project URL</label>
              <input className="input" placeholder="https://xxxx.supabase.co" value={supaUrl} onChange={(e) => setSupaUrl(e.target.value)} autoCorrect="off" spellCheck={false} />
            </div>
            <div className="field">
              <label className="field-label">Supabase service_role key</label>
              <input className="input" type="password" placeholder="eyJ…" value={supaKey} onChange={(e) => setSupaKey(e.target.value)} autoCorrect="off" spellCheck={false} />
              <div className="field-hint">Project Settings → API → service_role. Stays on this computer — it lets the app publish captions and answer attendees.</div>
            </div>
            <div className="field" style={{ marginBottom: 0 }}>
              <label className="field-label">Attendee web app URL</label>
              <input className="input" placeholder="https://your-app.vercel.app" value={webUrl} onChange={(e) => setWebUrl(e.target.value)} autoCorrect="off" spellCheck={false} />
              <div className="field-hint">Your Vercel deployment. With all three filled in, event QR codes point to the internet. Leave empty to use same-Wi-Fi mode.</div>
            </div>
          </div>
        </>
      )}

      {(showKeys || !isWeb) && (
        <div style={{ marginTop: 20, display: 'flex', gap: 10, alignItems: 'center' }}>
          <button className="btn btn-primary" onClick={() => void saveKeys()}>
            Save keys
          </button>
          {saved && (
            <span className="fade-in" style={{ color: 'var(--text-2)', fontSize: 13 }}>
              Saved
            </span>
          )}
        </div>
      )}
    </>
  )

  const helpPage = (
    <>
      <div className="card">
        <div className="start-row">
          <div className="start-mark">
            <Mark size={22} />
          </div>
          <div className="start-body">
            <div className="start-title">How Sitca works</div>
            <div className="field-hint" style={{ marginTop: 2 }}>
              A minute and a half, start to finish: a lecture captured, read, questioned and remembered. Watch it again any time.
            </div>
            <div className="start-actions">
              <button className="btn btn-sm" onClick={() => setShowTour(true)}>
                <IconPlay size={12} strokeWidth={2.2} />
                Watch the walkthrough
              </button>
            </div>
          </div>
        </div>
      </div>
      {!inExtension && (
        <div className="card" style={{ marginTop: 12 }}>
          <Row title="Sitca for Chrome" desc="A card on Google Meet, Zoom, Teams, Webex and YouTube. One press, and Sitca sits in.">
            <a className="btn btn-ghost btn-sm" href={isWeb ? '/extension' : `${SITE}/extension`} target="_blank" rel="noreferrer">
              Get it
            </a>
          </Row>
        </div>
      )}
      <div className="section-title">Talk to us</div>
      <div className="card">
        <div className="set-row contact-row">
          <div className="set-text">
            <div className="set-title">A person reads every message</div>
            <div className="set-desc">A question, a problem, an idea for what Sitca should do next.</div>
          </div>
          <div className="contact-ways">
            <a className="btn btn-ghost btn-sm" href={`https://wa.me/${WHATSAPP}`} target="_blank" rel="noreferrer">
              WhatsApp
            </a>
            <a className="btn btn-ghost btn-sm" href={`mailto:${MAIL}`}>
              Email
            </a>
            <a className="btn btn-ghost btn-sm" href="tel:+256759055133">
              Call
            </a>
          </div>
        </div>
      </div>
      <div className="section-title">About</div>
      <div className="card">
        <Row title="Sitca" desc="The AI that attends with you. Your recordings stay yours; answers point to the moment they came from." />
        <Row title="Version" desc={`${isWeb ? 'Web' : 'Desktop'} · ${inExtension ? 'Chrome extension · ' : ''}${new Date().getFullYear()}`} />
      </div>
    </>
  )

  const pages: Record<SectionId, React.ReactNode> = {
    account: accountPage,
    plan: planPage,
    preferences: preferencesPage,
    sessions: sessionsPage,
    data: dataPage,
    providers: providersPage,
    help: helpPage
  }

  // ---------- the frame ----------

  const rail = (
    <nav className="stg-rail" aria-label="Settings">
      <input className="input stg-search" placeholder="Search settings" value={query} onChange={(e) => setQuery(e.target.value)} spellCheck={false} />
      {GROUPS.map((g) => {
        const items = visible.filter((s) => s.group === g.id)
        if (items.length === 0) return null
        return (
          <div key={g.id} className="stg-group">
            <div className="stg-group-title">{g.title}</div>
            {items.map((s) => (
              <button key={s.id} className={`stg-nav${section === s.id ? ' on' : ''}`} onClick={() => open(s.id)}>
                <span className="stg-nav-ic">{s.icon}</span>
                <span>{s.title}</span>
              </button>
            ))}
          </div>
        )
      })}
      {visible.length === 0 && <div className="set-desc" style={{ padding: '6px 10px' }}>Nothing matches “{query.trim()}”.</div>}
    </nav>
  )

  const phoneList = (
    <div className="stg-list">
      <div className="stg-list-hero">
        <div className="set-avatar stg-avatar big">{initials}</div>
        <div className="stg-list-name">{profile?.name ?? 'You'}</div>
        {profile?.email && <div className="set-desc">{profile.email}</div>}
      </div>
      {hasPlan && plan.id === 'free' && (
        <button className="stg-upgrade" onClick={() => open('plan')}>
          <span className="stg-upgrade-mark">
            <Mark size={18} />
          </span>
          <span className="stg-upgrade-text">
            <b>Do more with Sitca</b>
            <span>More hours, more questions, recordings kept for a year.</span>
          </span>
          <span className="stg-upgrade-btn">See plans</span>
        </button>
      )}
      <input className="input stg-search" placeholder="Search settings" value={query} onChange={(e) => setQuery(e.target.value)} spellCheck={false} />
      {GROUPS.map((g) => {
        const items = visible.filter((s) => s.group === g.id)
        if (items.length === 0) return null
        return (
          <div key={g.id} className="stg-group">
            <div className="stg-group-title">{g.title}</div>
            <div className="stg-list-card">
              {items.map((s) => (
                <button key={s.id} className="stg-list-row" onClick={() => open(s.id)}>
                  <span className="stg-nav-ic">{s.icon}</span>
                  <span className="stg-list-text">
                    <span>{s.title}</span>
                    <small>{s.blurb}</small>
                  </span>
                  <span className="stg-list-chev">
                    <IconChevron size={16} strokeWidth={2} />
                  </span>
                </button>
              ))}
            </div>
          </div>
        )
      })}
      {visible.length === 0 && <div className="set-desc" style={{ padding: '6px 4px' }}>Nothing matches “{query.trim()}”.</div>}
    </div>
  )

  return (
    <div className="content stg-content">
      <div className="content-inner stg-inner">
        {showTour && <Tour onClose={closeTour} />}
        {confirmSignOut && (
          <ConfirmDialog
            title="Sign out?"
            message="Your sessions stay safely in your workspace. Sign back in any time to see them."
            confirmLabel="Sign out"
            onCancel={() => setConfirmSignOut(false)}
            onConfirm={() => {
              setConfirmSignOut(false)
              void window.sitka.signOut()
            }}
          />
        )}
        {deleting && <DeleteAccountDialog email={profile?.email ?? ''} onCancel={() => setDeleting(false)} />}
        {choosing && (
          <ChoosePlanDialog
            plan={choosing}
            current={plan}
            currency={currency}
            student={student}
            yearly={yearly}
            email={profile?.email ?? ''}
            onClose={() => setChoosing(null)}
          />
        )}

        {narrow ? (
          section === null || !current ? (
            <>
              <h1 className="page-title">Settings</h1>
              {phoneList}
            </>
          ) : (
            <>
              <button className="stg-back" onClick={() => setSection(null)}>
                <IconBack size={16} strokeWidth={2.2} />
                Settings
              </button>
              <h1 className="page-title stg-page-title">{current.title}</h1>
              {pages[current.id]}
            </>
          )
        ) : (
          <div className="stg-frame">
            {rail}
            <div className="stg-page" key={section ?? ''}>
              {current && (
                <>
                  <h1 className="page-title stg-page-title">{current.title}</h1>
                  <p className="page-subtitle stg-page-sub">{current.blurb}.</p>
                  {pages[current.id]}
                </>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

function useMedia(q: string): boolean {
  const [m, setM] = useState(() => window.matchMedia(q).matches)
  useEffect(() => {
    const mq = window.matchMedia(q)
    const on = (): void => setM(mq.matches)
    mq.addEventListener('change', on)
    return () => mq.removeEventListener('change', on)
  }, [q])
  return m
}

/**
 * Choosing a plan. Payments are not switched on yet: the choice becomes a
 * message to the people who run Sitca, who switch the plan on by hand the
 * same day. When a payment provider arrives, this is where it goes.
 */
function ChoosePlanDialog({
  plan,
  current,
  currency,
  student,
  yearly,
  email,
  onClose
}: {
  plan: Plan
  current: Plan
  currency: string
  student: boolean
  yearly: boolean
  email: string
  onClose: () => void
}): React.JSX.Element {
  const monthly = priceIn(plan, currency, student)
  const amount = monthly === null ? '' : monthly === 0 ? 'Free' : yearly ? `${formatMoney(monthly * 10, currency)} a year` : `${formatMoney(monthly, currency)} a month`
  const down = plan.id === 'free'
  const quote = plan.usd < 0
  const text = down
    ? `Hi Sitca, please move my account (${email}) to the Free plan.`
    : quote
      ? `Hi Sitca, I’d like to talk about the Institution plan for my organisation. My account is ${email}.`
      : `Hi Sitca, I’d like to move to ${plan.name} (${amount}${student && plan.usdStudent !== undefined ? ', student rate' : ''}). My account is ${email}. How do I pay?`
  const wa = `https://wa.me/${WHATSAPP}?text=${encodeURIComponent(text)}`
  const mail = `mailto:${MAIL}?subject=${encodeURIComponent(`Sitca ${plan.name}`)}&body=${encodeURIComponent(text)}`
  return createPortal(
    <div className="dialog-overlay" onMouseDown={onClose}>
      <div className="dialog stg-choose" onMouseDown={(e) => e.stopPropagation()}>
        <div className="stg-choose-plan">
          <Mark size={20} />
          <span>{plan.name}</span>
          {amount && <b>{amount}</b>}
        </div>
        <div className="dialog-title">{down ? 'Move to Free?' : quote ? 'Let’s talk' : `Get ${plan.name}`}</div>
        <div className="dialog-message">
          {down
            ? `You’re on ${current.name}. On Free, recordings are kept for 30 days and the month has ${planOf('free').limits.hours} hours. Nothing is deleted today; sessions older than 30 days go at the end of your paid period.`
            : quote
              ? 'Institution plans are priced per seat for your school, university or company. Tell us roughly how many people, and we will come back the same day.'
              : 'Card and mobile money payments inside Sitca are coming. Until then it is one message: we confirm the amount with you, take the payment by mobile money or bank, and switch the plan on the same day.'}
        </div>
        <div className="stg-choose-ways">
          <a className="btn btn-primary" href={wa} target="_blank" rel="noreferrer">
            Message on WhatsApp
          </a>
          <a className="btn" href={mail}>
            Send an email
          </a>
        </div>
        {!down && !quote && (
          <div className="set-desc" style={{ marginTop: 12 }}>
            Mobile money (MTN, Airtel), bank transfer, or a card through Flutterwave. You get a receipt either way.
          </div>
        )}
        <div className="dialog-actions" style={{ marginTop: 14 }}>
          <button className="btn btn-ghost" onClick={onClose}>
            Not now
          </button>
        </div>
      </div>
    </div>,
    document.body
  )
}

/**
 * The last dialog: the person types their email to be sure, and the account
 * is gone. The server checks the email again before it removes anything.
 */
function DeleteAccountDialog({ email, onCancel }: { email: string; onCancel: () => void }): React.JSX.Element {
  const [typed, setTyped] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const matches = typed.trim().toLowerCase() === email.trim().toLowerCase() && email.length > 0
  const go = async (): Promise<void> => {
    if (!matches || busy) return
    setBusy(true)
    setError('')
    const r = await window.sitka.deleteAccount(typed.trim()).catch((err: unknown) => ({ error: err instanceof Error ? err.message : String(err) }))
    if (r.error) {
      setError(r.error)
      setBusy(false)
    }
    // on success the page leaves on its own
  }
  return createPortal(
    <div className="dialog-overlay" onMouseDown={busy ? undefined : onCancel}>
      <div className="dialog delete-account" onMouseDown={(e) => e.stopPropagation()}>
        <div className="dialog-title">Delete your account?</div>
        <div className="dialog-message">
          This removes everything: your sessions and their recordings, notes, documents, practice projects, memory, and the organisations you created. Nothing can be brought back.
        </div>
        <label className="delete-account-label">
          Type <b>{email}</b> to confirm
        </label>
        <input
          className="input"
          value={typed}
          autoFocus
          autoComplete="off"
          spellCheck={false}
          placeholder={email}
          onChange={(e) => setTyped(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void go()
            if (e.key === 'Escape' && !busy) onCancel()
          }}
        />
        {error && <div className="notice notice-error delete-account-error">{error}</div>}
        <div className="dialog-actions">
          <button className="btn" onClick={onCancel} disabled={busy}>
            Keep my account
          </button>
          <button className="btn btn-danger" onClick={() => void go()} disabled={!matches || busy}>
            {busy ? 'Deleting…' : 'Delete everything'}
          </button>
        </div>
      </div>
    </div>,
    document.body
  )
}
