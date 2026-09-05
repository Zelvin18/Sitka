import React from 'react'
import {
  IconBroadcast,
  IconCalendar,
  IconMic,
  IconScreen,
  IconSparkle,
  IconStar
} from '../lib/icons'

interface Props {
  kind: 'business' | 'education'
  onBack: () => void
  onNewSession: () => void
  onGoEvents: () => void
  onGoCoach: () => void
  onGoOverview: () => void
}

/**
 * The doors into Sitka's two deep ecosystems. Sitka stays open to everyone;
 * these pages show what it does for a company or for a student and start
 * the right flow. No numbers here that Sitka has not earned.
 */
export default function EcosystemView({
  kind,
  onBack,
  onNewSession,
  onGoEvents,
  onGoCoach,
  onGoOverview
}: Props): React.JSX.Element {
  const business = kind === 'business'

  const starts = business
    ? [
        {
          icon: <IconScreen size={19} strokeWidth={1.7} />,
          title: 'Capture a meeting',
          desc: 'Decisions, promises and people are remembered — with the moment they were said.',
          go: onNewSession
        },
        {
          icon: <IconBroadcast size={19} strokeWidth={1.7} />,
          title: 'Host an event',
          desc: 'Every attendee gets a companion; you get the room’s mind and a lead-quality report.',
          go: onGoEvents
        },
        {
          icon: <IconMic size={19} strokeWidth={1.7} />,
          title: 'Prepare a pitch or negotiation',
          desc: 'Rehearse against a simulated investor, client or supplier and get scored.',
          go: onGoCoach
        }
      ]
    : [
        {
          icon: <IconScreen size={19} strokeWidth={1.7} />,
          title: 'Attend a lecture',
          desc: 'Live transcript, notes that write themselves, and answers at your level.',
          go: onNewSession
        },
        {
          icon: <IconStar size={19} strokeWidth={1.7} />,
          title: 'Study what you attended',
          desc: 'Concepts, flashcards and quizzes built from what your lecturer actually said.',
          go: onGoOverview
        },
        {
          icon: <IconMic size={19} strokeWidth={1.7} />,
          title: 'Practice a presentation or viva',
          desc: 'Rehearse with a simulated examiner and walk in prepared.',
          go: onGoCoach
        }
      ]

  const pillars = business
    ? [
        {
          name: 'Work',
          line: 'Meetings that remember their own decisions and promises.',
          points: [
            'Why did we decide this? Answered with the original moment.',
            'Promises that go quiet are flagged before they slip.',
            'Two rooms, two different decisions: Sitka notices.'
          ]
        },
        {
          name: 'Events',
          line: 'Conferences, launches and town halls with a companion in every seat.',
          points: [
            'Captions and answers in every language, live.',
            'What the room is privately confused about, while you can still fix it.',
            'Replay pages that answer questions long after the day.'
          ]
        },
        {
          name: 'Prepare',
          line: 'Walk into the important moments ready.',
          points: [
            'Briefs built from everything said with that client before.',
            'Negotiate against a simulated counterpart and get honest feedback.',
            'Practice memory feeds your live co-pilot on the day.'
          ]
        }
      ]
    : [
        {
          name: 'Learn',
          line: 'An AI that sat in the same lecture you did.',
          points: [
            'Explain what the lecturer meant, and jump to the exact moment.',
            'Notes, key moments and study packs that write themselves.',
            'Answers in your language, at your level.'
          ]
        },
        {
          name: 'Remember',
          line: 'Concepts tracked across the whole course, not one class.',
          points: [
            'Every concept, every time it was taught, in one place.',
            'Search everything you have ever attended.',
            'Where did I first learn this? One question away.'
          ]
        },
        {
          name: 'Prepare',
          line: 'Never cram alone again.',
          points: [
            'Rehearse presentations and vivas with a simulated examiner.',
            'Exam practice grounded in what was actually taught.',
            'Practice memory that follows you into the real thing.'
          ]
        }
      ]

  return (
    <div className="content">
      <div className="content-inner" style={{ maxWidth: 900 }}>
        <div className="page-back">
          <button className="btn btn-ghost btn-sm" onClick={onBack}>
            ‹ Back
          </button>
        </div>

        <div className="eco-hero">
          <div className="eco-kicker">{business ? 'Sitka for Business' : 'Sitka for Education'}</div>
          <h1 className="page-title" style={{ marginBottom: 8 }}>
            {business ? 'Turn conversations into coordinated action.' : 'Never learn alone again.'}
          </h1>
          <p className="page-subtitle" style={{ maxWidth: 600 }}>
            {business
              ? 'Meetings, projects, presentations, events and decisions — Sitka listens, understands, remembers, and helps your company act.'
              : 'Before class, during class, after class, before the exam — an AI that stays with you through your whole education.'}
          </p>
        </div>

        <div className="section-title">Start here</div>
        <div className="home-actions">
          {starts.map((s) => (
            <button key={s.title} className="home-action" onClick={s.go}>
              <span className="home-action-icon">{s.icon}</span>
              <span className="home-action-title">{s.title}</span>
              <span className="home-action-desc">{s.desc}</span>
            </button>
          ))}
        </div>

        <div className="section-title" style={{ marginTop: 34 }}>
          How it works for {business ? 'a company' : 'a student'}
        </div>
        <div className="eco-pillars">
          {pillars.map((p) => (
            <div key={p.name} className="eco-pillar">
              <div className="eco-pillar-name">{p.name}</div>
              <div className="eco-pillar-line">{p.line}</div>
              <ul className="eco-points">
                {p.points.map((pt) => (
                  <li key={pt}>{pt}</li>
                ))}
              </ul>
            </div>
          ))}
        </div>

        <div className="eco-note">
          <IconSparkle size={15} strokeWidth={1.8} />
          <span>
            {business
              ? 'Everything Sitka remembers lives in Overview under “What matters”: decisions, promises and the people behind them, each with the moment it was said.'
              : 'Everything Sitka learns with you lives in Overview under “What matters”: the concepts you were taught, each with the moment it was explained.'}
          </span>
          <button className="btn btn-sm" onClick={onGoOverview} style={{ marginLeft: 'auto' }}>
            Open Overview
          </button>
        </div>

        <div className="eco-foot">
          <IconCalendar size={14} />
          <span>
            {business
              ? 'Coming next: project intelligence, meeting briefs with practice against the real counterpart, and “what changed this week”.'
              : 'Coming next: explain-it-back checks after every lecture, exam simulation from your real course, and course memory across the semester.'}
          </span>
        </div>
      </div>
    </div>
  )
}
