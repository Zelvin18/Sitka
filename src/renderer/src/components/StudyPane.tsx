import React, { useState } from 'react'
import type { StudyPack } from '@shared/types'
import { IconSparkle } from '../lib/icons'

interface Props {
  study: StudyPack | null
  onGenerate: () => void
  generating: boolean
  error: string | null
  hasTranscript: boolean
}

export default function StudyPane({
  study,
  onGenerate,
  generating,
  error,
  hasTranscript
}: Props): React.JSX.Element {
  const [flipped, setFlipped] = useState<Set<number>>(new Set())
  const [answers, setAnswers] = useState<Record<number, number>>({})

  const toggleCard = (i: number): void => {
    setFlipped((prev) => {
      const next = new Set(prev)
      if (next.has(i)) next.delete(i)
      else next.add(i)
      return next
    })
  }

  if (!study) {
    return (
      <div className="transcript">
        <div className="empty" style={{ padding: '48px 24px' }}>
          <div className="empty-icon">
            <IconSparkle size={28} strokeWidth={1.4} />
          </div>
          <div className="empty-title">Study pack</div>
          <div style={{ marginBottom: 18, maxWidth: 380, marginInline: 'auto' }}>
            Sitka turns this session into key concepts, flashcards, and a quiz so you
            can revise without rewatching.
          </div>
          {error && (
            <div className="notice notice-error" style={{ textAlign: 'left' }}>
              <span>{error}</span>
            </div>
          )}
          <button
            className="btn btn-primary"
            onClick={onGenerate}
            disabled={generating || !hasTranscript}
          >
            {generating ? 'Generating…' : 'Generate study pack'}
          </button>
          {!hasTranscript && (
            <div className="field-hint" style={{ marginTop: 10 }}>
              This session has no transcript to study from.
            </div>
          )}
        </div>
      </div>
    )
  }

  return (
    <div className="transcript">
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          marginTop: 4
        }}
      >
        <div className="section-title" style={{ margin: 0 }}>
          Key concepts · {study.concepts.length}
        </div>
        <button className="btn btn-ghost btn-sm" onClick={onGenerate} disabled={generating}>
          {generating ? 'Regenerating…' : 'Regenerate'}
        </button>
      </div>
      <div style={{ marginTop: 10 }}>
        {study.concepts.map((c, i) => (
          <div key={i} className="concept-row">
            <strong>{c.term}</strong>
            <span>{c.definition}</span>
          </div>
        ))}
      </div>

      <div className="section-title">Flashcards · {study.flashcards.length}</div>
      <div className="flashcard-grid">
        {study.flashcards.map((f, i) => (
          <button key={i} className="flashcard" onClick={() => toggleCard(i)}>
            <div className="flashcard-tag">{flipped.has(i) ? 'Answer' : 'Card ' + (i + 1)}</div>
            <div className="flashcard-text">{flipped.has(i) ? f.back : f.front}</div>
            <div className="flashcard-hint">
              {flipped.has(i) ? 'Click to see question' : 'Click to reveal'}
            </div>
          </button>
        ))}
      </div>

      <div className="section-title">Quiz · {study.quiz.length} questions</div>
      {study.quiz.map((q, qi) => {
        const chosen = answers[qi]
        const answered = chosen !== undefined
        return (
          <div key={qi} className="quiz-q">
            <div className="quiz-question">
              {qi + 1}. {q.question}
            </div>
            {q.options.map((opt, oi) => {
              let cls = 'quiz-option'
              if (answered) {
                if (oi === q.answerIndex) cls += ' correct'
                else if (oi === chosen) cls += ' wrong'
                else cls += ' muted'
              }
              return (
                <button
                  key={oi}
                  className={cls}
                  disabled={answered}
                  onClick={() => setAnswers((prev) => ({ ...prev, [qi]: oi }))}
                >
                  <span className="quiz-letter">{String.fromCharCode(65 + oi)}</span>
                  {opt}
                </button>
              )
            })}
            {answered && (
              <div className="quiz-explain">
                {chosen === q.answerIndex ? 'Correct. ' : 'Not quite. '}
                {q.explanation}
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}
