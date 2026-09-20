import React from 'react'
import { periodResetLabel, planOf, usedShare, type Meter, type Usage } from '@shared/plans'
import { Mark } from '../lib/icons'

/**
 * A limit reached, said kindly: what was used, when it resets, and what
 * the person can do about it now. Never a wall; always a door or two.
 */
export default function LimitCard({
  meter,
  usage,
  onPlans,
  onLibrary,
  compact
}: {
  meter: Meter
  usage: Usage
  /** opens Settings, Plan & usage */
  onPlans: () => void
  /** opens the library, to delete sessions (only offered for storage) */
  onLibrary?: () => void
  /** a smaller card, for inside the chat */
  compact?: boolean
}): React.JSX.Element {
  const plan = planOf(usage.plan)
  const share = Math.round(usedShare(usage, meter) * 100)
  const reset = periodResetLabel(usage)
  const next = plan.id === 'free' ? planOf('plus') : plan.id === 'plus' ? planOf('pro') : null
  const title =
    meter === 'hours'
      ? `Your ${plan.limits.hours} hours for this month are used`
      : meter === 'asks'
        ? `Your ${plan.limits.asks} questions for this month are used`
        : `Your recordings fill the ${plan.limits.storageGb} GB you have`
  const line =
    meter === 'hours'
      ? `Recording opens again on ${reset}. Until then, you can still open every session, read, ask, and share.`
      : meter === 'asks'
        ? `Sitca answers again on ${reset}. Everything else keeps working: recording, captions, notes, recaps.`
        : 'Nothing is lost. Delete a session or two you no longer need, and recording continues.'
  const meterLabel = meter === 'hours' ? 'Recording' : meter === 'asks' ? 'Questions' : 'Storage'
  const used =
    meter === 'hours'
      ? `${usage.hours >= 10 ? usage.hours.toFixed(0) : usage.hours.toFixed(1)} / ${plan.limits.hours} h`
      : meter === 'asks'
        ? `${usage.asks} / ${plan.limits.asks}`
        : `${((usage.storageBytes ?? 0) / 1073741824).toFixed(1)} / ${plan.limits.storageGb} GB`
  return (
    <div className={`limit-card${compact ? ' compact' : ''}`}>
      <div className="limit-head">
        <span className="limit-mark">
          <Mark size={16} />
        </span>
        <div className="limit-text">
          <div className="limit-title">{title}</div>
          <div className="limit-line">{line}</div>
        </div>
      </div>
      <div className="limit-meter">
        <span>{meterLabel}</span>
        <div className="limit-bar">
          <i style={{ width: `${Math.max(3, share)}%` }} />
        </div>
        <b>{used}</b>
      </div>
      <div className="limit-actions">
        {next && (
          <button className="btn btn-primary btn-sm" onClick={onPlans}>
            See {next.name} · {meter === 'hours' ? `${next.limits.hours} hours` : meter === 'asks' ? (next.limits.asks ? `${next.limits.asks} questions` : 'unlimited questions') : `${next.limits.storageGb} GB`}
          </button>
        )}
        {meter === 'storage' && onLibrary && (
          <button className="btn btn-sm" onClick={onLibrary}>
            Free up space
          </button>
        )}
        {!next && (
          <button className="btn btn-sm" onClick={onPlans}>
            Talk to us
          </button>
        )}
        <span className="limit-reset">{plan.id === 'free' ? `Free plan · resets ${reset}` : `${plan.name} plan · resets ${reset}`}</span>
      </div>
    </div>
  )
}
