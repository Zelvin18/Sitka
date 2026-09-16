import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { CoachProject, TranscriptSegment } from '@shared/types'
import { paceLabel, speechMetrics, type AnswerVerdict } from '@shared/studioLogic'
import { IconCamera, IconMic, IconScreen, IconStop, Mark } from '../lib/icons'
import { prepareSpeech, speakText, type PreparedSpeech, type Speaker } from '../lib/speech'
import { formatTime } from '../lib/format'

/**
 * The practice studio: a stage, an audience, and a coach who whispers.
 *
 * Nothing the presenter says is echoed back at them: the words are kept in
 * the background for the score. What is on screen is what a coach would
 * notice — pace, fillers, a wavering voice, a term that came through wrong —
 * and an audience that behaves like one. Every minute or two someone raises
 * a hand. The question is written and its voice fetched before the hand is
 * shown, so taking it is instant: the person asks aloud, the presenter
 * answers aloud, and the verdict says what a strong answer would have been.
 */

interface Props {
  project: CoachProject
  segments: TranscriptSegment[]
  elapsed: number
  hasCam: boolean
  camOn: boolean
  sharing: boolean
  camVideoRef: React.RefObject<HTMLVideoElement>
  shareVideoRef: React.RefObject<HTMLVideoElement>
  micStream: MediaStream | null
  hint: string | null
  hasChatKey: boolean
  onToggleCam: () => void
  onPresent: () => void
  onStopShare: () => void
  onFinish: () => void
  /** something for the record: a question asked, a verdict given */
  onRecord: (text: string) => void
  /** the words said in the last few seconds are sent for transcription now, not at the next rotation */
  onFlush: () => void
}

type Phase = 'raised' | 'asking' | 'answering' | 'judging' | 'verdict'
interface Hand {
  persona: string
  question: string
  prepared: PreparedSpeech
  phase: Phase
  /** seconds into the rehearsal when the answer began */
  answerFrom: number
  verdict: AnswerVerdict | null
  /** which seat raised the hand */
  seat: number
}

const FIRST_HAND_AFTER = 75
const HAND_EVERY = 120
const MIN_WORDS_FOR_HAND = 50
const ANSWER_SILENCE = 12

const initials = (s: string): string =>
  s
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() ?? '')
    .join('') || 'A'

export default function PracticeStudio({
  project,
  segments,
  elapsed,
  hasCam,
  camOn,
  sharing,
  camVideoRef,
  shareVideoRef,
  micStream,
  hint,
  hasChatKey,
  onToggleCam,
  onPresent,
  onStopShare,
  onFinish,
  onRecord,
  onFlush
}: Props): React.JSX.Element {
  // ---- the voice: level and steadiness, from the microphone itself ----
  const [level, setLevel] = useState(0)
  const [voice, setVoice] = useState<'quiet' | 'steady' | 'wavering'>('quiet')
  useEffect(() => {
    if (!micStream || micStream.getAudioTracks().length === 0) return
    const ctx = new AudioContext()
    const keepAwake = (): void => {
      if (ctx.state !== 'running' && ctx.state !== 'closed') void ctx.resume().catch(() => undefined)
    }
    keepAwake()
    ctx.onstatechange = keepAwake
    const analyser = ctx.createAnalyser()
    analyser.fftSize = 1024
    ctx.createMediaStreamSource(micStream).connect(analyser)
    const buf = new Float32Array(analyser.fftSize)
    const history: number[] = []
    const timer = window.setInterval(() => {
      analyser.getFloatTimeDomainData(buf)
      let sum = 0
      for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i]
      const rms = Math.sqrt(sum / buf.length)
      setLevel(Math.min(1, rms * 9))
      history.push(rms)
      if (history.length > 120) history.shift()
      // over the last fifteen seconds: is the voice carrying, and is it even?
      const loud = history.filter((v) => v > 0.012)
      if (loud.length < 12) {
        setVoice('quiet')
        return
      }
      const mean = loud.reduce((a, b) => a + b, 0) / loud.length
      const sd = Math.sqrt(loud.reduce((a, b) => a + (b - mean) * (b - mean), 0) / loud.length)
      setVoice(sd / mean > 0.75 ? 'wavering' : 'steady')
    }, 125)
    return () => {
      clearInterval(timer)
      void ctx.close().catch(() => undefined)
    }
  }, [micStream])

  // ---- the words: measured, not shown ----
  const metrics = useMemo(() => speechMetrics(segments, elapsed), [segments, elapsed])
  const pace = paceLabel(metrics.wpm)

  // ---- the audience ----
  const seats = useMemo(() => {
    const main = (project.audience || 'Audience').trim()
    return [main, 'Listener', 'Listener', 'Listener']
  }, [project.audience])
  const [hand, setHand] = useState<Hand | null>(null)
  const handRef = useRef<Hand | null>(null)
  handRef.current = hand
  const askedRef = useRef<string[]>([])
  const lastHandAtRef = useRef(0)
  const fetchingRef = useRef(false)
  const speakerRef = useRef<Speaker | null>(null)
  const segmentsRef = useRef(segments)
  segmentsRef.current = segments
  const elapsedRef = useRef(elapsed)
  elapsedRef.current = elapsed

  // someone decides to raise a hand: the question is written and its voice
  // fetched first, so the hand appears with everything ready
  useEffect(() => {
    if (!hasChatKey) return
    const timer = window.setInterval(() => {
      if (handRef.current || fetchingRef.current) return
      const now = elapsedRef.current
      const since = now - lastHandAtRef.current
      const due = lastHandAtRef.current === 0 ? now >= FIRST_HAND_AFTER : since >= HAND_EVERY
      const words = segmentsRef.current.reduce((n, s) => n + s.text.split(/\s+/).filter(Boolean).length, 0)
      if (!due || words < MIN_WORDS_FOR_HAND) return
      fetchingRef.current = true
      void window.sitka
        .coachAudienceQuestion(project.id, segmentsRef.current, askedRef.current)
        .then((q) => {
          if (!q.question || handRef.current) return
          const persona = q.persona || seats[0]
          askedRef.current = [...askedRef.current, q.question].slice(-8)
          lastHandAtRef.current = elapsedRef.current
          setHand({
            persona,
            question: q.question,
            prepared: prepareSpeech(q.question, 'en'),
            phase: 'raised',
            answerFrom: 0,
            verdict: null,
            seat: Math.floor(Math.random() * seats.length)
          })
        })
        .catch(() => undefined)
        .finally(() => {
          fetchingRef.current = false
        })
    }, 5000)
    return () => clearInterval(timer)
  }, [hasChatKey, project.id, seats])

  useEffect(
    () => () => {
      speakerRef.current?.stop()
    },
    []
  )

  const takeQuestion = useCallback((): void => {
    const h = handRef.current
    if (!h || h.phase !== 'raised') return
    onRecord(`[Audience question from the ${h.persona}] ${h.question}`)
    setHand({ ...h, phase: 'asking' })
    speakerRef.current?.stop()
    speakerRef.current = h.prepared.play(() => {
      const cur = handRef.current
      if (!cur || cur.phase !== 'asking') return
      setHand({ ...cur, phase: 'answering', answerFrom: elapsedRef.current })
    })
  }, [onRecord])

  const notNow = useCallback((): void => {
    lastHandAtRef.current = elapsedRef.current
    setHand(null)
  }, [])

  const judge = useCallback((): void => {
    const h = handRef.current
    if (!h || h.phase !== 'answering') return
    setHand({ ...h, phase: 'judging' })
    // the last words said are still in the recorder: send them, give them a
    // moment to come back as text, then judge the whole answer
    onFlush()
    void new Promise((r) => setTimeout(r, 3500))
      .then(() => {
        const answer = segmentsRef.current
          .filter((s) => s.end >= h.answerFrom - 1 && !s.text.startsWith('['))
          .map((s) => s.text.trim())
          .join(' ')
        return window.sitka.coachJudgeAnswer(project.id, h.persona, h.question, answer)
      })
      .then((v) => {
        const cur = handRef.current
        if (!cur || cur.phase !== 'judging') return
        const verdict: AnswerVerdict = {
          verdict: v.verdict ?? 'needs-work',
          reason: v.reason ?? (v.error ? 'The coach could not judge this one.' : ''),
          strongAnswer: v.strongAnswer ?? '',
          spoken: v.spoken ?? ''
        }
        onRecord(`[Coach on that answer: ${verdict.verdict}] ${verdict.reason}`)
        setHand({ ...cur, phase: 'verdict', verdict })
        if (verdict.spoken) {
          speakerRef.current?.stop()
          speakerRef.current = speakText(verdict.spoken, 'en', () => undefined)
        }
      })
      .catch(() => {
        const cur = handRef.current
        if (cur) setHand({ ...cur, phase: 'verdict', verdict: { verdict: 'needs-work', reason: 'The coach could not judge this one.', strongAnswer: '', spoken: '' } })
      })
  }, [project.id, onRecord, onFlush])

  // an answer that has clearly finished (words, then silence) is judged by itself
  useEffect(() => {
    const h = hand
    if (!h || h.phase !== 'answering') return
    const answered = segments.filter((s) => s.end >= h.answerFrom - 1)
    const words = answered.reduce((n, s) => n + s.text.split(/\s+/).filter(Boolean).length, 0)
    if (words < 12) return
    const lastEnd = answered[answered.length - 1]?.end ?? h.answerFrom
    if (elapsed - lastEnd >= ANSWER_SILENCE) judge()
  }, [hand, segments, elapsed, judge])

  const dismiss = useCallback((): void => {
    speakerRef.current?.stop()
    lastHandAtRef.current = elapsedRef.current
    setHand(null)
  }, [])

  const questioner = hand ? hand.seat : -1
  const speaking = hand?.phase === 'asking'
  const verdictWord = (v: AnswerVerdict['verdict']): string =>
    v === 'strong' ? '✓ Strong' : v === 'weak' ? "✗ Doesn't hold" : '△ Needs work'

  return (
    <div className="ps">
      <div className="ps-top">
        <span className="ps-live">
          <span className="ps-live-dot" />
          Live practice
        </span>
        <span className="ps-title">{project.title}</span>
        <span className="ps-timer">{formatTime(elapsed)}</span>
      </div>

      <div className="ps-stage">
        <div className={`ps-frame${sharing ? ' sharing' : ''}${hasCam && camOn && !sharing ? ' cam' : ''}`}>
          {sharing ? (
            <video ref={shareVideoRef} autoPlay muted playsInline className="ps-share" />
          ) : hasCam ? (
            <video ref={camVideoRef} autoPlay muted playsInline className="ps-cam" />
          ) : (
            <div className="ps-orb-wrap">
              <div className="ps-orb" style={{ ['--lvl' as string]: level.toFixed(3) }}>
                <IconMic size={26} strokeWidth={1.6} />
              </div>
              <div className="ps-orb-note">Sitka is listening. Present as you would in the room.</div>
            </div>
          )}
          {sharing && hasCam && <video ref={camVideoRef} autoPlay muted playsInline className="ps-selfview" />}
          {hasCam && !camOn && !sharing && (
            <div className="ps-camoff">
              <IconCamera size={18} strokeWidth={1.6} />
              Camera off
            </div>
          )}

          {/* the coach's whisper */}
          {hint && (
            <div className="ps-hint fade-in">
              <Mark size={12} live />
              <span>{hint}</span>
            </div>
          )}

          {/* what a coach notices, measured as you go */}
          <div className="ps-pulse">
            <span className={`ps-pill${pace.off ? ' off' : ''}`}>
              <b>{metrics.wpm || '—'}</b> wpm · {pace.label}
            </span>
            <span className={`ps-pill${metrics.fillers >= 4 ? ' off' : ''}`}>
              <b>{metrics.fillers}</b> fillers
            </span>
            <span className={`ps-pill${voice === 'wavering' ? ' off' : ''}`}>
              voice · <b>{voice}</b>
            </span>
            {metrics.pause >= 6 && (
              <span className="ps-pill off">
                <b>{metrics.pause}s</b> pause
              </span>
            )}
          </div>

      {/* the raised hand, the question, the answer, the verdict */}
          {hand && (
            <div className={`ps-card ps-card-${hand.phase} fade-in`} role="dialog" aria-live="polite">
              {hand.phase === 'raised' && (
                <>
                  <div className="ps-card-kicker">
                    <span className="ps-card-hand">✋</span> {hand.persona} has a question
                  </div>
                  <div className="ps-card-actions">
                    <button className="ps-btn primary" onClick={takeQuestion}>
                      Take the question
                    </button>
                    <button className="ps-btn quiet" onClick={notNow}>
                      Not now
                    </button>
                  </div>
                </>
              )}
              {hand.phase === 'asking' && (
                <>
                  <div className="ps-card-kicker">{hand.persona} asks</div>
                  <div className="ps-card-question">“{hand.question}”</div>
                </>
              )}
              {hand.phase === 'answering' && (
                <>
                  <div className="ps-card-kicker">{hand.persona} asked</div>
                  <div className="ps-card-question small">“{hand.question}”</div>
                  <div className="ps-card-listen">
                    <span className="ps-listen-dot" />
                    Your answer, aloud. Sitka is listening.
                  </div>
                  <div className="ps-card-actions">
                    <button className="ps-btn primary" onClick={judge}>
                      Done answering
                    </button>
                    <button className="ps-btn quiet" onClick={dismiss}>
                      Skip
                    </button>
                  </div>
                </>
              )}
              {hand.phase === 'judging' && (
                <>
                  <div className="ps-card-kicker">{hand.persona} is weighing your answer</div>
                  <div className="ps-card-listen">
                    <Mark size={13} live />
                    A moment.
                  </div>
                </>
              )}
              {hand.phase === 'verdict' && hand.verdict && (
                <>
                  <div className={`ps-verdict v-${hand.verdict.verdict}`}>{verdictWord(hand.verdict.verdict)}</div>
                  {hand.verdict.reason && <div className="ps-card-reason">{hand.verdict.reason}</div>}
                  {hand.verdict.strongAnswer && (
                    <div className="ps-card-strong">
                      <div className="ps-card-strong-label">A strong answer</div>
                      {hand.verdict.strongAnswer}
                    </div>
                  )}
                  <div className="ps-card-actions">
                    <button className="ps-btn primary" onClick={dismiss}>
                      Continue
                    </button>
                  </div>
                </>
              )}
            </div>
          )}
        </div>

        <div className="ps-audience">
          {seats.map((name, i) => {
            const isQ = i === questioner
            const label = isQ && hand ? hand.persona : name
            return (
              <div key={i} className={`ps-seat${isQ ? ' hand' : ''}${isQ && speaking ? ' speaking' : ''}`}>
                <span className="ps-avatar">
                  {initials(label)}
                  {isQ && <span className="ps-handchip" aria-label="Hand raised">✋</span>}
                </span>
                <span className="ps-seat-name">{label}</span>
                <span className="ps-seat-state">
                  {isQ && speaking ? (
                    <span className="ps-wave">
                      <i />
                      <i />
                      <i />
                    </span>
                  ) : isQ ? (
                    'has a question'
                  ) : (
                    'listening'
                  )}
                </span>
              </div>
            )
          })}
        </div>
      </div>

      <div className="ps-dock">
        {hasCam && (
          <button className={`ps-btn${camOn ? '' : ' off'}`} onClick={onToggleCam} title="Toggle camera">
            <IconCamera size={15} strokeWidth={1.9} />
            <span>{camOn ? 'Camera' : 'Camera off'}</span>
          </button>
        )}
        {sharing ? (
          <button className="ps-btn off" onClick={onStopShare}>
            <IconScreen size={15} strokeWidth={1.9} />
            <span>Stop sharing</span>
          </button>
        ) : (
          <button className="ps-btn" onClick={onPresent}>
            <IconScreen size={15} strokeWidth={1.9} />
            <span>Present slides</span>
          </button>
        )}
        <button className="ps-btn end" onClick={onFinish}>
          <IconStop size={14} strokeWidth={2.4} />
          <span>End &amp; get scored</span>
        </button>
      </div>

    </div>
  )
}
