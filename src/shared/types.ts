export interface Settings {
  anthropicApiKey: string
  openaiApiKey: string
  /** Free-tier key from console.groq.com — fallback for both chat and transcription */
  groqApiKey: string
  /** Online events (cloud relay): Supabase project URL, e.g. https://xyz.supabase.co */
  supabaseUrl: string
  /** Supabase service_role key — stays on this machine, never sent to attendees */
  supabaseServiceKey: string
  /** Deployed attendee web app, e.g. https://sitka.vercel.app */
  webAppUrl: string
}

export interface TranscriptSegment {
  /** seconds from session start */
  start: number
  end: number
  text: string
}

export interface SessionHighlight {
  /** "M:SS" or "H:MM:SS" */
  time: string
  label: string
}

export type SessionStatus = 'recording' | 'complete'

export type SessionKind = 'lecture' | 'meeting' | 'presentation' | 'other'

/** Which ecosystem a session belongs to; undefined = the general workspace */
export type Space = 'business' | 'education'

export interface SessionMeta {
  id: string
  title: string
  createdAt: number
  durationMs: number
  status: SessionStatus
  summary?: string
  highlights?: SessionHighlight[]
  analyzed?: boolean
  /** true once the recording has been rewritten with a proper seek index */
  remuxed?: boolean
  /** set when a highlight reel video has been rendered */
  reelGeneratedAt?: number
  /** what was captured — tunes analysis and which tab leads */
  kind?: SessionKind
  /** true when the session broadcast to a live audience */
  hosted?: boolean
  /** the host's planned talking points (drives coverage + event report) */
  agenda?: string[]
  /** the scheduled event this session went live for */
  eventId?: string
  /** recorded inside Sitka for Business / Education (undefined = general) */
  space?: Space
}

export interface ChatMessage {
  role: 'user' | 'assistant'
  content: string
  at: number
}

export type MomentKind = 'important' | 'question'

export interface SessionMoment {
  /** "M:SS" or "H:MM:SS" */
  time: string
  label: string
  kind: MomentKind
}

export interface SessionNotes {
  /** markdown, continuously rewritten as the session progresses */
  markdown: string
  moments: SessionMoment[]
  updatedAt: number
}

export interface Flashcard {
  front: string
  back: string
}

export interface QuizQuestion {
  question: string
  options: string[]
  answerIndex: number
  explanation: string
}

export interface Concept {
  term: string
  definition: string
}

export interface StudyPack {
  concepts: Concept[]
  flashcards: Flashcard[]
  quiz: QuizQuestion[]
  generatedAt: number
}

export interface SessionData {
  meta: SessionMeta
  segments: TranscriptSegment[]
  chat: ChatMessage[]
  notes: SessionNotes | null
  study: StudyPack | null
  /** seconds the user pinned with the mark hotkey/button */
  marks: number[]
  /** audience report for hosted sessions */
  report: EventReport | null
}

export interface CaptureSource {
  id: string
  name: string
  /** data URL thumbnail */
  thumbnail: string
  kind: 'screen' | 'window'
}

export interface AskRequest {
  sessionId: string
  requestId: string
  question: string
  /** true while the session is still being recorded */
  live: boolean
  history: ChatMessage[]
  /** JPEG data URL of the current screen frame (live sessions only) */
  frame?: string
  /** host co-pilot mode: terse, audience-focused answers */
  host?: boolean
}

export interface AiStreamEvent {
  requestId: string
  type: 'delta' | 'done' | 'error'
  text?: string
  error?: string
}

export interface TranscribeResult {
  segments?: TranscriptSegment[]
  error?: string
}

export interface BrainSearchHit {
  sessionId: string
  sessionTitle: string
  /** seconds into that session */
  time: number
  snippet: string
}

export interface BrainStats {
  sessions: number
  totalMs: number
  words: number
  moments: number
}

export interface BrainAskRequest {
  requestId: string
  question: string
  history: ChatMessage[]
}

export interface EventReport {
  /** attendees who joined over the whole event */
  joined: number
  /** most phones connected at once */
  peak: number
  /** private AI questions attendees asked */
  aiAsks: number
  questions: { topic: string; items: { text: string; at: number }[] }[]
  agenda?: string[]
  endedAt: number
  insights?: {
    overview: string
    coverage: { topic: string; covered: boolean; note?: string }[]
    followUps: string[]
  }
}

export interface EventMaterial {
  name: string
  /** extracted text length */
  chars: number
}

export interface ScheduledEvent {
  id: string
  title: string
  /** planned start (ms epoch); optional */
  startsAt?: number
  /** port reserved so the QR stays valid */
  port?: number
  createdAt: number
  agenda?: string[]
  materials?: EventMaterial[]
  /** host choice: may early scanners chat with the AI before the event starts? (default true) */
  preEventChat?: boolean
  /** Live Voice: translated live captions + spoken audio on attendee phones */
  liveVoice?: { enabled: boolean; languages: string[] }
  /** session recorded for this event (set when it goes live) */
  sessionId?: string
}

// ---------- Coach (prepare → rehearse → simulate) ----------

export interface CoachBrief {
  structure: string[]
  keyMessage: string
  weakAreas: string[]
  expectedQuestions: string[]
}

export interface CoachScores {
  content: number
  clarity: number
  structure: number
  confidence: number
  timing: number
  overall: number
}

export interface CoachRehearsal {
  id: string
  at: number
  durationSec: number
  scores: CoachScores
  feedback: string[]
  summary: string
}

export type SimDifficulty = 'friendly' | 'professional' | 'challenging' | 'grilling'

export interface CoachProject {
  id: string
  title: string
  /** what they are presenting */
  goal: string
  /** who the audience is */
  audience: string
  when?: number
  createdAt: number
  materials?: EventMaterial[]
  brief?: CoachBrief
  rehearsals: CoachRehearsal[]
  /** linked hosted event — practice memory feeds the live Co-Pilot */
  eventId?: string
}

// ---------- Memory: durable things Sitka keeps across sessions ----------

export type MemoryKind = 'decision' | 'commitment' | 'person' | 'concept'

export interface MemoryMoment {
  sessionId: string
  sessionTitle: string
  /** "M:SS" or "H:MM:SS" within that session */
  time: string
  /** what happened at this moment (one sentence) */
  note: string
  at: number
}

export interface MemoryObject {
  id: string
  kind: MemoryKind
  title: string
  /** current understanding (latest) */
  detail: string
  /** decisions: open | changed (needs a look) · commitments: open | done */
  status?: 'open' | 'changed' | 'done'
  /** commitments: who owns it */
  owner?: string
  /** commitments: due date YYYY-MM-DD when stated */
  due?: string
  timeline: MemoryMoment[]
  createdAt: number
  updatedAt: number
}

export interface BrainConversation {
  id: string
  title: string
  createdAt: number
  updatedAt: number
  messages: ChatMessage[]
}
