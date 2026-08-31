import { app } from 'electron'
import { promises as fs } from 'fs'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { randomUUID } from 'crypto'
import type {
  BrainConversation,
  ChatMessage,
  CoachProject,
  EventReport,
  ScheduledEvent,
  SessionData,
  SessionMeta,
  SessionNotes,
  Settings,
  StudyPack,
  TranscriptSegment
} from '@shared/types'

const userData = (): string => app.getPath('userData')
const settingsPath = (): string => join(userData(), 'settings.json')
export const sessionsRoot = (): string => join(userData(), 'sessions')
const sessionDir = (id: string): string => join(sessionsRoot(), id)
const metaPath = (id: string): string => join(sessionDir(id), 'meta.json')
const transcriptPath = (id: string): string => join(sessionDir(id), 'transcript.json')
const chatPath = (id: string): string => join(sessionDir(id), 'chat.json')
const notesPath = (id: string): string => join(sessionDir(id), 'notes.json')
const studyPath = (id: string): string => join(sessionDir(id), 'study.json')
export const videoPath = (id: string): string => join(sessionDir(id), 'video.webm')
export const reelPath = (id: string): string => join(sessionDir(id), 'highlights.webm')
const marksPath = (id: string): string => join(sessionDir(id), 'marks.json')

function readJson<T>(path: string, fallback: T): T {
  try {
    if (!existsSync(path)) return fallback
    return JSON.parse(readFileSync(path, 'utf-8')) as T
  } catch {
    return fallback
  }
}

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, JSON.stringify(value, null, 2), 'utf-8')
}

// ---------- settings ----------

const DEFAULT_SETTINGS: Settings = {
  anthropicApiKey: '',
  openaiApiKey: '',
  groqApiKey: '',
  supabaseUrl: '',
  supabaseServiceKey: '',
  webAppUrl: ''
}

export function getSettings(): Settings {
  return { ...DEFAULT_SETTINGS, ...readJson<Partial<Settings>>(settingsPath(), {}) }
}

export function setSettings(settings: Settings): void {
  writeJson(settingsPath(), settings)
}

// ---------- sessions ----------

export function createSession(
  title: string,
  kind: SessionMeta['kind'] = 'other',
  hosted = false,
  agenda?: string[]
): SessionMeta {
  const id = randomUUID()
  mkdirSync(sessionDir(id), { recursive: true })
  const meta: SessionMeta = {
    id,
    title: title || 'Untitled session',
    createdAt: Date.now(),
    durationMs: 0,
    status: 'recording',
    kind,
    hosted,
    agenda: agenda && agenda.length > 0 ? agenda.slice(0, 12) : undefined
  }
  writeJson(metaPath(id), meta)
  writeJson(transcriptPath(id), [])
  writeJson(chatPath(id), [])
  return meta
}

export function getMeta(id: string): SessionMeta | null {
  return readJson<SessionMeta | null>(metaPath(id), null)
}

export function saveMeta(meta: SessionMeta): void {
  writeJson(metaPath(meta.id), meta)
}

export function listSessions(): SessionMeta[] {
  const root = sessionsRoot()
  if (!existsSync(root)) return []
  const out: SessionMeta[] = []
  for (const entry of readdirSync(root)) {
    const meta = getMeta(entry)
    if (meta) out.push(meta)
  }
  return out.sort((a, b) => b.createdAt - a.createdAt)
}

export function getSessionData(id: string): SessionData | null {
  const meta = getMeta(id)
  if (!meta) return null
  return {
    meta,
    segments: readJson<TranscriptSegment[]>(transcriptPath(id), []),
    chat: readJson<ChatMessage[]>(chatPath(id), []),
    notes: readJson<SessionNotes | null>(notesPath(id), null),
    study: readJson<StudyPack | null>(studyPath(id), null),
    marks: readJson<number[]>(marksPath(id), []),
    report: readJson<EventReport | null>(reportPath(id), null)
  }
}

const reportPath = (id: string): string => join(sessionDir(id), 'report.json')

export function getReport(id: string): EventReport | null {
  return readJson<EventReport | null>(reportPath(id), null)
}

export function saveReport(id: string, report: EventReport): void {
  writeJson(reportPath(id), report)
}

export function getMarks(id: string): number[] {
  return readJson<number[]>(marksPath(id), [])
}

export function addMark(id: string, seconds: number): number[] {
  const marks = getMarks(id)
  marks.push(Math.max(0, Math.round(seconds)))
  marks.sort((a, b) => a - b)
  writeJson(marksPath(id), marks)
  return marks
}

export function getNotes(id: string): SessionNotes | null {
  return readJson<SessionNotes | null>(notesPath(id), null)
}

export function saveNotes(id: string, notes: SessionNotes): void {
  writeJson(notesPath(id), notes)
}

// ---------- events (the hosting ecosystem) ----------

const legacyUpcomingPath = (): string => join(userData(), 'upcoming-event.json')
const eventsPath = (): string => join(userData(), 'events.json')
const materialsDir = (): string => join(userData(), 'event-materials')
const materialsPath = (id: string): string => join(materialsDir(), `${id}.json`)

export function listEvents(): ScheduledEvent[] {
  const events = readJson<ScheduledEvent[]>(eventsPath(), [])
  // One-time migration of the old single upcoming event.
  if (existsSync(legacyUpcomingPath())) {
    try {
      const legacy = readJson<ScheduledEvent | null>(legacyUpcomingPath(), null)
      if (legacy && !events.some((e) => e.id === legacy.id)) {
        events.push(legacy)
        writeJson(eventsPath(), events)
      }
      rmSync(legacyUpcomingPath(), { force: true })
    } catch {
      /* best effort */
    }
  }
  return events.sort((a, b) => (a.startsAt ?? Infinity) - (b.startsAt ?? Infinity))
}

export function getEvent(id: string): ScheduledEvent | null {
  return listEvents().find((e) => e.id === id) ?? null
}

export function saveEvent(event: ScheduledEvent): void {
  const events = listEvents().filter((e) => e.id !== event.id)
  events.push(event)
  writeJson(eventsPath(), events)
}

export function deleteEvent(id: string): void {
  writeJson(
    eventsPath(),
    listEvents().filter((e) => e.id !== id)
  )
  rmSync(materialsPath(id), { force: true })
}

interface StoredMaterial {
  name: string
  text: string
}

export function getMaterials(eventId: string): StoredMaterial[] {
  return readJson<StoredMaterial[]>(materialsPath(eventId), [])
}

export function saveMaterials(eventId: string, materials: StoredMaterial[]): void {
  mkdirSync(materialsDir(), { recursive: true })
  writeJson(materialsPath(eventId), materials)
}

/** Concatenated event material text for AI grounding, capped. */
export function getMaterialsText(eventId: string | undefined, cap = 14000): string | null {
  if (!eventId) return null
  const materials = getMaterials(eventId)
  if (materials.length === 0) return null
  let out = ''
  for (const m of materials) {
    const chunk = `--- ${m.name} ---\n${m.text}\n\n`
    if (out.length + chunk.length > cap) {
      out += chunk.slice(0, Math.max(0, cap - out.length))
      break
    }
    out += chunk
  }
  return out.trim() || null
}

// ---------- coach projects ----------

const coachPath = (): string => join(userData(), 'coach-projects.json')
const coachMaterialsDir = (): string => join(userData(), 'coach-materials')
const coachMaterialsPath = (id: string): string => join(coachMaterialsDir(), `${id}.json`)
const coachSimPath = (id: string): string => join(coachMaterialsDir(), `${id}-sim.json`)

export function listCoachProjects(): CoachProject[] {
  return readJson<CoachProject[]>(coachPath(), []).sort((a, b) => b.createdAt - a.createdAt)
}

export function getCoachProject(id: string): CoachProject | null {
  return listCoachProjects().find((p) => p.id === id) ?? null
}

export function saveCoachProject(project: CoachProject): void {
  const all = listCoachProjects().filter((p) => p.id !== project.id)
  all.push(project)
  writeJson(coachPath(), all)
}

export function deleteCoachProject(id: string): void {
  writeJson(
    coachPath(),
    listCoachProjects().filter((p) => p.id !== id)
  )
  rmSync(coachMaterialsPath(id), { force: true })
  rmSync(coachSimPath(id), { force: true })
}

export function getCoachMaterials(id: string): { name: string; text: string }[] {
  return readJson<{ name: string; text: string }[]>(coachMaterialsPath(id), [])
}

export function saveCoachMaterials(id: string, materials: { name: string; text: string }[]): void {
  mkdirSync(coachMaterialsDir(), { recursive: true })
  writeJson(coachMaterialsPath(id), materials)
}

export function getCoachMaterialsText(id: string, cap = 14000): string | null {
  const materials = getCoachMaterials(id)
  if (materials.length === 0) return null
  let out = ''
  for (const m of materials) {
    const chunk = `--- ${m.name} ---\n${m.text}\n\n`
    if (out.length + chunk.length > cap) {
      out += chunk.slice(0, Math.max(0, cap - out.length))
      break
    }
    out += chunk
  }
  return out.trim() || null
}

export function getCoachSim(id: string): ChatMessage[] {
  return readJson<ChatMessage[]>(coachSimPath(id), [])
}

export function saveCoachSim(id: string, chat: ChatMessage[]): void {
  mkdirSync(coachMaterialsDir(), { recursive: true })
  writeJson(coachSimPath(id), chat)
}

// ---------- brain (cross-session) conversations ----------

const legacyBrainChatPath = (): string => join(userData(), 'brain-chat.json')
const brainChatsPath = (): string => join(userData(), 'brain-chats.json')

function readBrainChats(): BrainConversation[] {
  const chats = readJson<BrainConversation[]>(brainChatsPath(), [])
  // One-time migration of the old single brain chat.
  if (existsSync(legacyBrainChatPath())) {
    try {
      const legacy = readJson<ChatMessage[]>(legacyBrainChatPath(), [])
      if (legacy.length > 0) {
        const firstUser = legacy.find((m) => m.role === 'user')
        chats.push({
          id: randomUUID(),
          title: (firstUser?.content ?? 'Earlier conversation').slice(0, 60),
          createdAt: legacy[0]?.at ?? Date.now(),
          updatedAt: legacy[legacy.length - 1]?.at ?? Date.now(),
          messages: legacy
        })
        writeJson(brainChatsPath(), chats)
      }
      rmSync(legacyBrainChatPath(), { force: true })
    } catch {
      /* migration is best-effort */
    }
  }
  return chats
}

export function listBrainChats(): BrainConversation[] {
  return readBrainChats().sort((a, b) => b.updatedAt - a.updatedAt)
}

export function saveBrainConversation(conv: BrainConversation): void {
  const chats = readBrainChats().filter((c) => c.id !== conv.id)
  chats.push(conv)
  writeJson(brainChatsPath(), chats)
}

export function deleteBrainConversation(id: string): void {
  writeJson(
    brainChatsPath(),
    readBrainChats().filter((c) => c.id !== id)
  )
}

export function getStudy(id: string): StudyPack | null {
  return readJson<StudyPack | null>(studyPath(id), null)
}

export function saveStudy(id: string, study: StudyPack): void {
  writeJson(studyPath(id), study)
}

export function getTranscript(id: string): TranscriptSegment[] {
  return readJson<TranscriptSegment[]>(transcriptPath(id), [])
}

export function appendTranscript(id: string, segments: TranscriptSegment[]): void {
  const all = getTranscript(id)
  all.push(...segments)
  all.sort((a, b) => a.start - b.start)
  writeJson(transcriptPath(id), all)
}

export function saveChat(id: string, chat: ChatMessage[]): void {
  writeJson(chatPath(id), chat)
}

export async function appendVideoChunk(id: string, chunk: Buffer): Promise<void> {
  await fs.appendFile(videoPath(id), chunk)
}

export async function deleteSession(id: string): Promise<void> {
  await fs.rm(sessionDir(id), { recursive: true, force: true })
}
