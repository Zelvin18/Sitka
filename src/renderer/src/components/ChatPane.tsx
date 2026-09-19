import FilePick from './FilePick'
import React, {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState
} from 'react'
import type { AiStreamEvent, ChatMessage } from '@shared/types'
import AiText from './AiText'
import { MAX_ATTACHMENTS, attachedLine, foldAttachments } from '@shared/attachLogic'
import type { ChatAttachment } from '@shared/types'
import { fileToAttachment, frameToDataUrl } from '../lib/attach'
import { looksBack, mmss, needsScreen, pickFrames } from '@shared/askLogic'
import { IconPlus as IconAttach } from '../lib/icons'

/** A named usage event for the owners' dashboard; a no-op on the desktop. */
const trackUse = (name: string, props: Record<string, unknown> = {}): void =>
  (window as unknown as { sitkaTrack?: (n: string, p: Record<string, unknown>) => void }).sitkaTrack?.(name, props)
import { speakText, type Speaker } from '../lib/speech'
import { IconChevron, IconCopy, IconSend, IconSparkle, IconSpeaker, IconStop, Mark } from '../lib/icons'
import { cleanForSpeech, copyRich } from '../lib/clipboard'

interface Props {
  sessionId: string
  live: boolean
  initialChat: ChatMessage[]
  hasChatKey: boolean
  hasTranscript: boolean
  onSeek: (seconds: number, sessionId?: string) => void
  onOpenSettings: () => void
  suggestions?: string[]
  /** capture the current screen frame (live sessions) so the AI can see it */
  getFrame?: () => string | null
  /** cross-session mode: questions go to the whole library */
  brain?: boolean
  /** host co-pilot mode: terse, audience-focused stage-manager answers */
  host?: boolean
  /** resolve a session-id prefix to a title (Brain citations) */
  resolveLabel?: (sid: string) => string | undefined
  headerTitle?: string
  /** overrides built-in persistence (Overview conversations) */
  onPersist?: (messages: ChatMessage[]) => void
  headerExtra?: React.ReactNode
  /** fully custom ask transport (Coach simulations) — still streams on ai:stream */
  askOverride?: (requestId: string, question: string, history: ChatMessage[]) => void
  /** custom empty state and input placeholder (organisation spaces) */
  emptyTitle?: string
  emptyDesc?: string
  placeholder?: string
}

export interface ChatPaneHandle {
  /** programmatically send a question, as if the user typed it */
  ask: (question: string) => void
  /** drop a note from Sitca into the conversation (nudges, things it noticed) */
  note: (text: string) => void
}

const ChatPane = forwardRef<ChatPaneHandle, Props>(function ChatPane(
  {
    sessionId,
    live,
    initialChat,
    hasChatKey,
    hasTranscript,
    onSeek,
    onOpenSettings,
    suggestions,
    getFrame,
    brain,
    host,
    resolveLabel,
    headerTitle,
    onPersist,
    headerExtra,
    askOverride,
    emptyTitle,
    emptyDesc,
    placeholder
  }: Props,
  ref
): React.JSX.Element {
  const [messages, setMessages] = useState<ChatMessage[]>(initialChat)
  const [input, setInput] = useState('')
  const [streaming, setStreaming] = useState(false)
  const [streamText, setStreamText] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [copiedIdx, setCopiedIdx] = useState<number | null>(null)
  const [speakingIdx, setSpeakingIdx] = useState<number | null>(null)
  /** true from the tap on the speaker until the first sound plays */
  const [speakPrep, setSpeakPrep] = useState(false)
  /** Phone only: fold the conversation away so the content above gets the screen. */
  const [folded, setFolded] = useState(false)
  /** the current question carries a picture of the screen */
  const [withFrame, setWithFrame] = useState(false)
  /** files added with + for the next question */
  const [attachments, setAttachments] = useState<ChatAttachment[]>([])
  const [attachBusy, setAttachBusy] = useState<string | null>(null)
  const speakerRef = useRef<Speaker | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const activeRequest = useRef<string | null>(null)
  const streamBuffer = useRef('')
  const lastQuestionRef = useRef<string | null>(null)
  const messagesRef = useRef(messages)
  messagesRef.current = messages

  useEffect(() => {
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [messages, streamText])

  // The conversation may be written elsewhere too: from the extension's card
  // while this page watches, or from another device. Whatever arrives that
  // this page does not have is joined in, in time order; nothing here is lost.
  useEffect(() => {
    if (streaming) return
    setMessages((prev) => {
      const key = (m: ChatMessage): string => `${m.at}|${m.role}|${m.content.slice(0, 80)}`
      const have = new Set(prev.map(key))
      const fresh = initialChat.filter((m) => !have.has(key(m)))
      if (fresh.length === 0) return prev
      return [...prev, ...fresh].sort((a, b) => a.at - b.at)
    })
  }, [initialChat, streaming])

  useEffect(() => {
    const off = window.sitka.onAiStream((event: AiStreamEvent) => {
      if (event.requestId !== activeRequest.current) return
      if (event.type === 'delta') {
        streamBuffer.current += event.text ?? ''
        setStreamText(streamBuffer.current)
      } else if (event.type === 'done') {
        const finalText = streamBuffer.current
        activeRequest.current = null
        streamBuffer.current = ''
        setStreaming(false)
        setStreamText('')
        setMessages((prev) => {
          const next: ChatMessage[] = [
            ...prev,
            { role: 'assistant', content: finalText, at: Date.now() }
          ]
          if (onPersist) onPersist(next)
          else if (!brain) void window.sitka.saveChat(sessionId, next)
          return next
        })
      } else if (event.type === 'error') {
        activeRequest.current = null
        streamBuffer.current = ''
        setStreaming(false)
        setStreamText('')
        setError(
          event.error === 'missing-key'
            ? 'missing-key'
            : event.error ?? 'Something went wrong.'
        )
      }
    })
    return off
  }, [sessionId, brain, onPersist])

  const send = useCallback(
    (question: string) => {
      let q = question.trim()
      const atts = [...attachments]
      if ((!q && atts.length === 0) || streaming) return
      if (!q) q = 'Tell me about what I attached.'
      setError(null)
      const requestId = crypto.randomUUID()
      activeRequest.current = requestId
      streamBuffer.current = ''
      lastQuestionRef.current = q
      const history = messagesRef.current
      setInput('')
      setAttachments([])
      setStreaming(true)
      setStreamText('')
      setFolded(false)
      if (askOverride) {
        // these transports take text only: documents go in as text
        setMessages((prev) => [...prev, { role: 'user', content: q + attachedLine(atts), at: Date.now() }])
        askOverride(requestId, foldAttachments(q, atts).question, history)
        return
      }
      if (brain) {
        setMessages((prev) => [...prev, { role: 'user', content: q + attachedLine(atts), at: Date.now() }])
        void window.sitka.askBrain({ requestId, question: foldAttachments(q, atts).question, history })
        return
      }
      // The screen is read only when the words ask for it: "what is on the
      // slide", "explain this chart". A question about what the speaker said
      // is answered from the session, with no look at the screen.
      const frame = host || !needsScreen(q) ? undefined : getFrame?.() ?? undefined
      setWithFrame(Boolean(frame))
      void (async () => {
        // A question that points back — "the table he showed earlier", "at
        // 12:30" — fetches the frames from that moment and looks at them.
        if (!host && !frame && looksBack(q)) {
          try {
            const slides = await window.sitka.listSlides(sessionId)
            const picked = pickFrames(slides, q)
            for (const s of picked) {
              const dataUrl = await frameToDataUrl(s.image)
              if (dataUrl) {
                atts.push({
                  id: crypto.randomUUID(),
                  name: `On screen at ${mmss(s.time)}`,
                  kind: 'image',
                  from: 'screen',
                  dataUrl
                })
              }
            }
          } catch {
            /* the [On screen] lines in the session still carry what was read */
          }
        }
        setMessages((prev) => [...prev, { role: 'user', content: q + attachedLine(atts), at: Date.now() }])
        void window.sitka.askAi({
          sessionId,
          requestId,
          question: q,
          live,
          history,
          host,
          frame,
          attachments: atts.length > 0 ? atts : undefined
        })
      })()
    },
    [sessionId, live, streaming, getFrame, brain, host, askOverride, attachments]
  )

  const addFiles = useCallback(async (files: FileList | File[] | null): Promise<void> => {
    if (!files || files.length === 0) return
    setError(null)
    for (const f of Array.from(files)) {
      if (attachments.length >= MAX_ATTACHMENTS) {
        setError(`Up to ${MAX_ATTACHMENTS} files per question.`)
        break
      }
      setAttachBusy(f.name)
      const res = await fileToAttachment(f)
      if ('error' in res) setError(res.error)
      else {
        trackUse('attach', { kind: res.kind })
        setAttachments((prev) => (prev.length < MAX_ATTACHMENTS ? [...prev, res] : prev))
      }
    }
    setAttachBusy(null)
    // on a phone the keyboard waits for a tap on the box
    if (window.innerWidth >= 860) inputRef.current?.focus()
  }, [attachments.length])

  const addNote = useCallback((text: string) => {
    setMessages((prev) => [...prev, { role: 'assistant', content: text, at: Date.now(), kind: 'note' }])
    setFolded(false)
  }, [])
  useImperativeHandle(ref, () => ({ ask: (question: string) => send(question), note: addNote }), [send, addNote])

  // Stop any speech when leaving the pane.
  useEffect(() => {
    return () => {
      speakerRef.current?.stop()
      window.speechSynthesis?.cancel()
    }
  }, [])

  const copyMessage = useCallback((index: number, content: string): void => {
    void copyRich(content).then((ok) => {
      if (ok) {
        setCopiedIdx(index)
        setTimeout(() => setCopiedIdx((cur) => (cur === index ? null : cur)), 2000)
      }
    })
  }, [])

  const speakMessage = useCallback(
    (index: number, content: string): void => {
      speakerRef.current?.stop()
      speakerRef.current = null
      if (speakingIdx === index) {
        setSpeakingIdx(null)
        return
      }
      const lang = document.documentElement.lang || navigator.language || 'en'
      setSpeakingIdx(index)
      setSpeakPrep(true)
      setError(null)
      trackUse('listen', { chars: content.length })
      speakerRef.current = speakText(
        cleanForSpeech(content),
        lang,
        (ok) => {
          speakerRef.current = null
          setSpeakPrep(false)
          setSpeakingIdx((cur) => (cur === index ? null : cur))
          if (!ok) {
            trackUse('voice_error', {})
            setError(
              'The voice could not play. Check the device is not muted, then tap the speaker again.'
            )
          }
        },
        () => setSpeakPrep(false)
      )
    },
    [speakingIdx]
  )

  const timeLabel = (at: number): string =>
    new Date(at).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })

  // Re-send the last question after a network failure without duplicating the
  // user's bubble (it is already in the message list).
  const retry = useCallback((): void => {
    const q = lastQuestionRef.current
    if (!q || streaming) return
    setError(null)
    const requestId = crypto.randomUUID()
    activeRequest.current = requestId
    streamBuffer.current = ''
    const msgs = messagesRef.current
    const last = msgs[msgs.length - 1]
    const history =
      last && last.role === 'user' && last.content === q ? msgs.slice(0, -1) : msgs
    setStreaming(true)
    setStreamText('')
    if (askOverride) {
      askOverride(requestId, q, history)
    } else if (brain) {
      void window.sitka.askBrain({ requestId, question: q, history })
    } else {
      void window.sitka.askAi({
        sessionId,
        requestId,
        question: q,
        live,
        history,
        host,
        frame: host ? undefined : getFrame?.() ?? undefined
      })
    }
  }, [sessionId, live, streaming, getFrame, brain, host, askOverride])

  const friendlyError = (raw: string): string => {
    if (/fetch failed|ETIMEDOUT|ENOTFOUND|ECONNRESET|network/i.test(raw)) {
      return 'Could not reach the AI service — your internet connection may have dropped for a moment.'
    }
    return raw
  }

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      send(input)
    }
  }

  const autoGrow = (): void => {
    const el = inputRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 120)}px`
  }

  const showSuggestions =
    messages.length === 0 && !streaming && hasChatKey && (suggestions?.length ?? 0) > 0

  return (
    <div className={folded ? 'chat chat-folded' : 'chat'}>
      <div className="chat-header">
        <IconSparkle size={15} />
        {headerTitle ?? 'Ask Sitca'}
        {headerExtra && <span style={{ marginLeft: 'auto' }}>{headerExtra}</span>}
        {live && (
          <span style={{ marginLeft: headerExtra ? 8 : 'auto' }} className="live-badge">
            ● LIVE
          </span>
        )}
        <button
          className="chat-fold"
          title={folded ? 'Show the conversation' : 'Hide the conversation'}
          aria-label={folded ? 'Show the conversation' : 'Hide the conversation'}
          onClick={() => setFolded((v) => !v)}
        >
          <IconChevron size={16} strokeWidth={2.2} />
        </button>
      </div>

      <div className="chat-scroll" ref={scrollRef}>
        {messages.length === 0 && !streaming && (
          <div className="chat-empty">
            <IconSparkle size={22} />
            <div className="chat-empty-title">
              {emptyTitle ??
                (brain
                  ? 'Ask across everything'
                  : live
                    ? 'Sitca is listening with you'
                    : 'Ask about this session')}
            </div>
            <div style={{ fontSize: 13 }}>
              {emptyDesc ??
                (brain
                  ? 'One question searches every session you have ever captured — answers link straight to the exact moments.'
                  : live
                    ? 'Ask anything about what is being said or shown — explanations, summaries, or "what did I miss?".'
                    : 'Ask what was covered, or find the exact moment something was said.')}
            </div>
          </div>
        )}

        {messages.map((m, i) =>
          m.role === 'user' ? (
            <div key={i} className="msg-user fade-in">
              {m.content}
            </div>
          ) : (
            <div key={i} className={m.kind === 'note' ? 'msg-ai-wrap msg-note fade-in' : 'msg-ai-wrap'}>
              {m.kind === 'note' && (
                <div className="msg-note-label">
                  <IconSparkle size={12} />
                  Sitca noticed
                </div>
              )}
              <AiText text={m.content} onSeek={onSeek} resolveLabel={resolveLabel} />
              <div className="msg-actions">
                <button
                  className="msg-action"
                  title="Copy this response"
                  onClick={() => copyMessage(i, m.content)}
                >
                  <IconCopy size={13} />
                  {copiedIdx === i && <span>Copied</span>}
                </button>
                <button
                  className="msg-action"
                  title={speakingIdx === i ? 'Stop reading' : 'Read aloud'}
                  onClick={() => speakMessage(i, m.content)}
                >
                  {speakingIdx === i ? (
                    speakPrep ? (
                      <Mark size={13} live />
                    ) : (
                      <IconStop size={13} />
                    )
                  ) : (
                    <IconSpeaker size={13} />
                  )}
                  {speakingIdx === i && speakPrep && <span>Preparing</span>}
                </button>
                <span className="msg-time">{timeLabel(m.at)}</span>
              </div>
            </div>
          )
        )}

        {streaming && (
          <div className="fade-in">
            {streamText ? (
              <AiText text={streamText} onSeek={onSeek} resolveLabel={resolveLabel} />
            ) : (
              <span className="dots-mark">
                <Mark size={16} live />
                {withFrame ? 'Reading the screen' : 'Thinking'}
              </span>
            )}
          </div>
        )}

        {error === 'missing-key' && (
          <div className="notice notice-error">
            <span>
              Add an Anthropic key — or a free Groq key — in{' '}
              <span className="link" onClick={onOpenSettings}>
                Settings
              </span>{' '}
              to ask Sitca questions.
            </span>
          </div>
        )}
        {error && error !== 'missing-key' && (
          <div className="notice notice-error">
            <span style={{ flex: 1 }}>{friendlyError(error)}</span>
            {lastQuestionRef.current && (
              <button className="btn btn-sm" onClick={retry} style={{ flexShrink: 0 }}>
                Try again
              </button>
            )}
          </div>
        )}
      </div>

      {showSuggestions && (
        <div className="chat-suggestions">
          {suggestions!.map((s) => (
            <button key={s} className="suggestion" onClick={() => send(s)}>
              {s}
            </button>
          ))}
        </div>
      )}

      <div className="chat-input-wrap">
        {(attachments.length > 0 || attachBusy) && (
          <div className="attach-row">
            {attachments.map((a) => (
              <span key={a.id} className="attach-chip" title={a.name}>
                {a.kind === 'image' && a.dataUrl ? <img src={a.dataUrl} alt="" /> : null}
                <span className="attach-name">{a.name}</span>
                <button
                  type="button"
                  aria-label={`Remove ${a.name}`}
                  onClick={() => setAttachments((prev) => prev.filter((x) => x.id !== a.id))}
                >
                  ×
                </button>
              </span>
            ))}
            {attachBusy && (
              <span className="attach-chip busy">
                <Mark size={14} live />
                <span className="attach-name">Reading {attachBusy}</span>
              </span>
            )}
          </div>
        )}
        <div className="chat-input-box">
          <FilePick onFiles={(files) => void addFiles(files)} hint="It travels with your question.">
            {(open) => (
              <button
                type="button"
                className="attach-btn"
                title="Add a picture or a document to your question"
                aria-label="Attach a file"
                disabled={streaming || Boolean(attachBusy)}
                onClick={open}
              >
                <IconAttach size={16} strokeWidth={2.2} />
              </button>
            )}
          </FilePick>
          <textarea
            ref={inputRef}
            className="chat-input"
            rows={1}
            placeholder={
              placeholder ??
              (brain
                ? 'Ask across all your sessions…'
                : hasTranscript || live
                  ? 'Ask about this session…'
                  : 'No transcript yet — nothing to ask about')
            }
            value={input}
            onChange={(e) => {
              setInput(e.target.value)
              autoGrow()
            }}
            onKeyDown={onKeyDown}
            disabled={streaming}
          />
          <button
            className="send-btn"
            onClick={() => send(input)}
            disabled={(!input.trim() && attachments.length === 0) || streaming}
            title="Send"
          >
            <IconSend size={15} strokeWidth={2.2} />
          </button>
        </div>
      </div>
    </div>
  )
})

export default ChatPane
