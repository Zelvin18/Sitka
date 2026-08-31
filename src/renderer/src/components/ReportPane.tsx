import React, { useState } from 'react'
import type { EventReport } from '@shared/types'
import { IconBroadcast, IconSparkle } from '../lib/icons'

interface Props {
  sessionId: string
  report: EventReport | null
  hasChatKey: boolean
  onUpdated: (report: EventReport) => void
}

export default function ReportPane({
  sessionId,
  report,
  hasChatKey,
  onUpdated
}: Props): React.JSX.Element {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  if (!report) {
    return (
      <div className="transcript">
        <div className="empty" style={{ padding: '48px 24px' }}>
          <div className="empty-icon">
            <IconBroadcast size={28} strokeWidth={1.4} />
          </div>
          <div className="empty-title">No event report</div>
          <div style={{ maxWidth: 380, marginInline: 'auto' }}>
            This session was hosted, but no audience data was captured — the report is
            written when a hosted session ends while the event server is running.
          </div>
        </div>
      </div>
    )
  }

  const totalQuestions = report.questions.reduce((n, g) => n + g.items.length, 0)

  const generate = (): void => {
    setBusy(true)
    setError(null)
    void window.sitka.reportInsights(sessionId).then((res) => {
      setBusy(false)
      if (res.error) {
        setError(
          res.error === 'missing-key' ? 'Add an AI key in Settings first.' : res.error
        )
      } else if (res.report) {
        onUpdated(res.report)
      }
    })
  }

  return (
    <div className="transcript">
      <div className="report-strip">
        <span>
          <strong>{report.joined}</strong> joined
        </span>
        <span className="report-dot" />
        <span>
          <strong>{report.peak}</strong> peak live
        </span>
        <span className="report-dot" />
        <span>
          <strong>{totalQuestions}</strong> question{totalQuestions === 1 ? '' : 's'} for the speaker
        </span>
        <span className="report-dot" />
        <span>
          <strong>{report.aiAsks}</strong> private AI ask{report.aiAsks === 1 ? '' : 's'}
        </span>
      </div>

      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          marginTop: 20
        }}
      >
        <div className="section-title" style={{ margin: 0 }}>
          Insights
        </div>
        <button
          className={`btn btn-sm${report.insights ? ' btn-ghost' : ' btn-primary'}`}
          onClick={generate}
          disabled={busy || !hasChatKey}
        >
          <IconSparkle size={13} />
          {busy ? 'Analyzing…' : report.insights ? 'Regenerate' : 'Generate insights'}
        </button>
      </div>
      {error && (
        <div className="notice notice-error" style={{ marginTop: 10 }}>
          <span>{error}</span>
        </div>
      )}
      {report.insights ? (
        <p className="summary-block" style={{ marginTop: 10 }}>
          {report.insights.overview}
        </p>
      ) : (
        !busy && (
          <p className="summary-block" style={{ marginTop: 10 }}>
            Let Sitka read the event and tell you how it went, what was missed, and
            what to follow up on.
          </p>
        )
      )}

      {(report.insights?.coverage?.length ?? 0) > 0 ? (
        <>
          <div className="section-title">Planned topics</div>
          <div className="agenda-list">
            {report.insights!.coverage.map((c, i) => (
              <div key={i} className={`agenda-item${c.covered ? ' done' : ''}`}>
                <span className="agenda-tick">{c.covered ? '✓' : ''}</span>
                <span style={{ flex: 1 }}>
                  {c.topic}
                  {c.note && (
                    <span style={{ color: 'var(--text-3)', fontSize: 12 }}> — {c.note}</span>
                  )}
                </span>
              </div>
            ))}
          </div>
        </>
      ) : (
        (report.agenda?.length ?? 0) > 0 && (
          <>
            <div className="section-title">Planned topics</div>
            <div className="agenda-list">
              {report.agenda!.map((topic, i) => (
                <div key={i} className="agenda-item">
                  <span className="agenda-tick" />
                  {topic}
                </div>
              ))}
            </div>
          </>
        )
      )}

      {(report.insights?.followUps?.length ?? 0) > 0 && (
        <>
          <div className="section-title">Follow-ups</div>
          <ul style={{ margin: '0 0 4px 20px', color: 'var(--text-2)' }}>
            {report.insights!.followUps.map((f, i) => (
              <li key={i} style={{ marginBottom: 6 }}>
                {f}
              </li>
            ))}
          </ul>
        </>
      )}

      <div className="section-title">Audience questions</div>
      {report.questions.length === 0 && (
        <div className="transcript-waiting">No questions were submitted.</div>
      )}
      {report.questions.map((g) => (
        <div key={g.topic} className="qgroup">
          <div className="qgroup-head">
            {g.topic}
            <span className="duration-chip">{g.items.length}</span>
          </div>
          {g.items.map((q, i) => (
            <div key={i} className="qgroup-item">
              {q.text}
            </div>
          ))}
        </div>
      ))}
    </div>
  )
}
