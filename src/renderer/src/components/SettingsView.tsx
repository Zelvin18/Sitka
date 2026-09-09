import React, { useCallback, useEffect, useState } from 'react'
import type { Profile, Settings } from '@shared/types'
import Tour from './Tour'
import ConfirmDialog from './ConfirmDialog'
import { IconPlay, Mark } from '../lib/icons'
import { applyAppearance } from '../lib/prefs'

interface Props {
  settings: Settings | null
  onSaved: (s: Settings) => void
  /** opens a session (used by the sample lecture) */
  onOpenSession?: (id: string) => void
}

const isWeb = (window as unknown as { sitkaWeb?: boolean }).sitkaWeb === true
const CAN_SHARE_SCREEN = typeof navigator.mediaDevices?.getDisplayMedia === 'function'

const LANGUAGES = [
  ['', 'Same as I write'],
  ['English', 'English'],
  ['Shona', 'Shona'],
  ['Ndebele', 'Ndebele'],
  ['Swahili', 'Swahili'],
  ['French', 'French'],
  ['Portuguese', 'Portuguese'],
  ['Spanish', 'Spanish'],
  ['Arabic', 'Arabic'],
  ['Chinese', 'Chinese']
] as const

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

function Row({ title, desc, children, wrap }: { title: string; desc?: string; children: React.ReactNode; wrap?: boolean }): React.JSX.Element {
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

export default function SettingsView({ settings, onSaved, onOpenSession }: Props): React.JSX.Element {
  const [showTour, setShowTour] = useState(false)
  const closeTour = useCallback(() => setShowTour(false), [])
  const [sampleBusy, setSampleBusy] = useState(false)
  const [profile, setProfile] = useState<Profile | null>(null)
  const [confirmSignOut, setConfirmSignOut] = useState(false)
  const [showKeys, setShowKeys] = useState(false)

  const [anthropicKey, setAnthropicKey] = useState('')
  const [openaiKey, setOpenaiKey] = useState('')
  const [groqKey, setGroqKey] = useState('')
  const [supaUrl, setSupaUrl] = useState('')
  const [supaKey, setSupaKey] = useState('')
  const [webUrl, setWebUrl] = useState('')
  const [saved, setSaved] = useState(false)

  useEffect(() => {
    void window.sitka.getProfile().then(setProfile)
  }, [])

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

  async function openSample(): Promise<void> {
    if (sampleBusy || !onOpenSession) return
    setSampleBusy(true)
    try {
      const meta = await window.sitka.createSampleSession()
      if (meta) onOpenSession(meta.id)
    } finally {
      setSampleBusy(false)
    }
  }

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
  const notes = settings?.notes !== false
  const readScreen = settings?.readScreen !== false
  const defaultCapture = settings?.defaultCapture ?? (CAN_SHARE_SCREEN ? 'screen' : 'camera')
  const initials = (profile?.name || 'You')
    .split(/\s+/)
    .map((w) => w[0])
    .join('')
    .slice(0, 2)
    .toUpperCase()

  return (
    <div className="content">
      <div className="content-inner" style={{ maxWidth: 640 }}>
        <h1 className="page-title">Settings</h1>
        <p className="page-subtitle">How Sitka looks, listens, answers and remembers. Changes apply straight away.</p>

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

        <div className="section-title">Account</div>
        <div className="card">
          <div className="set-account">
            <div className="set-avatar">{initials}</div>
            <div className="set-text">
              <div className="set-account-name">{profile?.name ?? 'You'}</div>
              <div className="set-account-mail">
                {profile?.email ?? (profile?.cloud ? 'Online workspace' : 'Local workspace on this computer')}
              </div>
            </div>
            {profile?.cloud && (
              <button className="btn btn-ghost btn-sm" onClick={() => setConfirmSignOut(true)}>
                Sign out
              </button>
            )}
          </div>
        </div>

        <div className="section-title">Appearance</div>
        <div className="card">
          <Row title="Theme" desc="Follow your device, or keep Sitka light or dark." wrap>
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

        <div className="section-title">During a session</div>
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
          <Row title="Read the screen" desc="Sitka reads slides, the board and charts whenever the picture settles on something new.">
            <Toggle on={readScreen} onChange={(v) => void persist({ readScreen: v })} label="Read the screen" />
          </Row>
          <Row title="Notes from Sitka" desc="Short notes in the chat when Sitka notices something worth your attention.">
            <Toggle on={notes} onChange={(v) => void persist({ notes: v })} label="Notes from Sitka" />
          </Row>
        </div>

        <div className="section-title">Answers</div>
        <div className="card">
          <Row title="Answer in" desc="The language Sitka replies in, whatever language the session is in." wrap>
            <select className="set-select" value={answerLanguage} onChange={(e) => void persist({ answerLanguage: e.target.value })}>
              {LANGUAGES.map(([v, label]) => (
                <option key={v} value={v}>
                  {label}
                </option>
              ))}
            </select>
          </Row>
        </div>

        <div className="section-title">Getting started</div>
        <div className="card">
          <div className="start-row">
            <div className="start-mark">
              <Mark size={22} live={sampleBusy} />
            </div>
            <div className="start-body">
              <div className="start-title">How Sitka works</div>
              <div className="field-hint" style={{ marginTop: 2 }}>
                A minute and a half, start to finish: a lecture captured, read, questioned and remembered. Watch it again any
                time.
              </div>
              <div className="start-actions">
                <button className="btn btn-sm" onClick={() => setShowTour(true)}>
                  <IconPlay size={12} strokeWidth={2.2} />
                  Watch the walkthrough
                </button>
                {onOpenSession && (
                  <button className="btn btn-ghost btn-sm" onClick={() => void openSample()} disabled={sampleBusy}>
                    {sampleBusy ? 'Preparing…' : 'Open the sample lecture'}
                  </button>
                )}
              </div>
            </div>
          </div>
        </div>

        <div className="section-title">AI providers</div>
        <div className="card">
          <div className="set-keys-note">
            {isWeb
              ? 'Sitka comes with its AI included. Add your own keys only if you want to use your own accounts; they stay in this browser and are sent straight to each provider.'
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
                <input
                  className="input"
                  type="password"
                  placeholder="gsk_…"
                  value={groqKey}
                  onChange={(e) => setGroqKey(e.target.value)}
                  autoCorrect="off"
                  spellCheck={false}
                />
                <div className="field-hint">
                  One free key covers transcription and answers. Create it at console.groq.com — no card required.
                </div>
              </div>
              <div className="field">
                <label className="field-label">Anthropic API key</label>
                <input
                  className="input"
                  type="password"
                  placeholder="sk-ant-…"
                  value={anthropicKey}
                  onChange={(e) => setAnthropicKey(e.target.value)}
                  autoCorrect="off"
                  spellCheck={false}
                />
                <div className="field-hint">
                  The highest quality answers and the most reliable reading of the screen. Preferred whenever present.
                </div>
              </div>
              <div className="field" style={{ marginBottom: 0 }}>
                <label className="field-label">OpenAI API key</label>
                <input
                  className="input"
                  type="password"
                  placeholder="sk-…"
                  value={openaiKey}
                  onChange={(e) => setOpenaiKey(e.target.value)}
                  autoCorrect="off"
                  spellCheck={false}
                />
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
                <input
                  className="input"
                  placeholder="https://xxxx.supabase.co"
                  value={supaUrl}
                  onChange={(e) => setSupaUrl(e.target.value)}
                  autoCorrect="off"
                  spellCheck={false}
                />
              </div>
              <div className="field">
                <label className="field-label">Supabase service_role key</label>
                <input
                  className="input"
                  type="password"
                  placeholder="eyJ…"
                  value={supaKey}
                  onChange={(e) => setSupaKey(e.target.value)}
                  autoCorrect="off"
                  spellCheck={false}
                />
                <div className="field-hint">
                  Project Settings → API → service_role. Stays on this computer — it lets the app publish captions and
                  answer attendees.
                </div>
              </div>
              <div className="field" style={{ marginBottom: 0 }}>
                <label className="field-label">Attendee web app URL</label>
                <input
                  className="input"
                  placeholder="https://your-app.vercel.app"
                  value={webUrl}
                  onChange={(e) => setWebUrl(e.target.value)}
                  autoCorrect="off"
                  spellCheck={false}
                />
                <div className="field-hint">
                  Your Vercel deployment. With all three filled in, event QR codes point to the internet. Leave empty to use
                  same-Wi-Fi mode.
                </div>
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

        <div className="section-title">About</div>
        <div className="card">
          <Row title="Sitka" desc="The AI that attends with you. Your recordings stay yours; answers point to the moment they came from.">
            <a className="btn btn-ghost btn-sm" href={isWeb ? '/legal' : 'https://sitka-blue.vercel.app/legal'} target="_blank" rel="noreferrer">
              Privacy &amp; Terms
            </a>
          </Row>
        </div>
      </div>
    </div>
  )
}
