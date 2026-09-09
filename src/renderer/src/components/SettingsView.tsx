import React, { useCallback, useEffect, useState } from 'react'
import type { Settings } from '@shared/types'
import Tour from './Tour'
import { IconPlay, Mark } from '../lib/icons'

interface Props {
  settings: Settings | null
  onSaved: (s: Settings) => void
  /** opens a session (used by the sample lecture) */
  onOpenSession?: (id: string) => void
}

const isWeb = (window as unknown as { sitkaWeb?: boolean }).sitkaWeb === true

export default function SettingsView({ settings, onSaved, onOpenSession }: Props): React.JSX.Element {
  const [showTour, setShowTour] = useState(false)
  const closeTour = useCallback(() => setShowTour(false), [])
  const [sampleBusy, setSampleBusy] = useState(false)
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
  const [anthropicKey, setAnthropicKey] = useState('')
  const [openaiKey, setOpenaiKey] = useState('')
  const [groqKey, setGroqKey] = useState('')
  const [supaUrl, setSupaUrl] = useState('')
  const [supaKey, setSupaKey] = useState('')
  const [webUrl, setWebUrl] = useState('')
  const [saved, setSaved] = useState(false)

  useEffect(() => {
    if (settings) {
      setAnthropicKey(settings.anthropicApiKey)
      setOpenaiKey(settings.openaiApiKey)
      setGroqKey(settings.groqApiKey)
      setSupaUrl(settings.supabaseUrl ?? '')
      setSupaKey(settings.supabaseServiceKey ?? '')
      setWebUrl(settings.webAppUrl ?? '')
    }
  }, [settings])

  const save = async (): Promise<void> => {
    const next: Settings = {
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

  return (
    <div className="content">
      <div className="content-inner" style={{ maxWidth: 620 }}>
        <h1 className="page-title">Settings</h1>
        <p className="page-subtitle">
          Your keys are stored only on this computer and are used only to call each
          provider directly.
        </p>

        {showTour && <Tour onClose={closeTour} />}
        <div className="section-title">Getting started</div>
        <div className="card">
          <div className="start-row">
            <div className="start-mark">
              <Mark size={22} live={sampleBusy} />
            </div>
            <div className="start-body">
              <div className="start-title">How Sitka works</div>
              <div className="field-hint" style={{ marginTop: 2 }}>
                A minute and a half, start to finish: a lecture captured, read, questioned
                and remembered. Watch it again any time.
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

        <div className="section-title">Free for testing</div>
        <div className="card">
          <div className="field" style={{ marginBottom: 0 }}>
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
              One free key covers everything: transcription (Whisper) and Ask Sitka
              (Llama). Create it at console.groq.com — no card required. Used
              automatically whenever a key below is missing.
            </div>
          </div>
        </div>

        <div className="section-title">Best quality</div>
        <div className="card">
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
              Powers Ask Sitka, session summaries, and moment search with Claude — the
              highest quality. Get a key at console.anthropic.com. Preferred over Groq
              when present.
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
            <div className="field-hint">
              Powers live transcription (Whisper). Get a key at platform.openai.com.
              Preferred over Groq when present.
            </div>
          </div>
        </div>

        {!isWeb && (
        <><div className="section-title">Online events</div>
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
              Project Settings → API → service_role. Stays on this computer — it lets
              the app publish captions and answer attendees.
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
              Your Vercel deployment. With all three filled in, event QR codes point to
              the internet — attendees join from anywhere, no shared Wi-Fi needed. Leave
              empty to use same-Wi-Fi mode.
            </div>
          </div>
        </div></>
        )}

        <div style={{ marginTop: 20, display: 'flex', gap: 10, alignItems: 'center' }}>
          <button className="btn btn-primary" onClick={() => void save()}>
            Save
          </button>
          {saved && (
            <span className="fade-in" style={{ color: 'var(--text-2)', fontSize: 13 }}>
              Saved
            </span>
          )}
        </div>
      </div>
    </div>
  )
}
