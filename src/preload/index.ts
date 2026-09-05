import { contextBridge, ipcRenderer } from 'electron'
import type {
  AiStreamEvent,
  AskRequest,
  BrainAskRequest,
  BrainConversation,
  BrainSearchHit,
  BrainStats,
  CoachProject,
  CoachRehearsal,
  EventReport,
  MemoryObject,
  ScheduledEvent,
  SimDifficulty,
  TranscriptSegment,
  CaptureSource,
  ChatMessage,
  SessionData,
  SessionMeta,
  SessionNotes,
  Settings,
  StudyPack,
  TranscribeResult
} from '@shared/types'

const api = {
  getSettings: (): Promise<Settings> => ipcRenderer.invoke('settings:get'),
  setSettings: (s: Settings): Promise<void> => ipcRenderer.invoke('settings:set', s),

  listSources: (): Promise<CaptureSource[]> => ipcRenderer.invoke('sources:list'),

  getThumb: (id: string): Promise<string | null> =>
    ipcRenderer.invoke('session:thumb', id),
  createSession: (
    title: string,
    kind?: 'lecture' | 'meeting' | 'presentation' | 'other',
    hosted?: boolean,
    agenda?: string[],
    eventId?: string,
    space?: 'business' | 'education'
  ): Promise<SessionMeta> =>
    ipcRenderer.invoke('session:create', title, kind, hosted, agenda, eventId, space),
  hostCoverage: (id: string): Promise<{ covered: boolean[] }> =>
    ipcRenderer.invoke('host:coverage', id),
  reportInsights: (id: string): Promise<{ report?: EventReport; error?: string }> =>
    ipcRenderer.invoke('report:insights', id),
  listSessions: (): Promise<SessionMeta[]> => ipcRenderer.invoke('session:list'),
  getSession: (id: string): Promise<SessionData | null> =>
    ipcRenderer.invoke('session:get', id),
  deleteSession: (id: string): Promise<void> => ipcRenderer.invoke('session:delete', id),
  saveChat: (id: string, chat: ChatMessage[]): Promise<void> =>
    ipcRenderer.invoke('session:saveChat', id, chat),
  appendChunk: (id: string, chunk: ArrayBuffer): Promise<void> =>
    ipcRenderer.invoke('session:appendChunk', id, chunk),
  readVideo: (id: string, file: 'video' | 'reel' = 'video'): Promise<Uint8Array | null> =>
    ipcRenderer.invoke('session:readVideo', id, file),
  setRecordingState: (state: { id: string; startedAt: number } | null): Promise<void> =>
    ipcRenderer.invoke('session:recordingState', state),
  markNow: (): Promise<void> => ipcRenderer.invoke('session:markNow'),
  onSessionMarked: (
    cb: (payload: { sessionId: string; time: number }) => void
  ): (() => void) => {
    const listener = (
      _e: Electron.IpcRendererEvent,
      payload: { sessionId: string; time: number }
    ): void => cb(payload)
    ipcRenderer.on('session:marked', listener)
    return () => ipcRenderer.removeListener('session:marked', listener)
  },
  generateReel: (id: string): Promise<{ error?: string }> =>
    ipcRenderer.invoke('reel:generate', id),
  saveReel: (
    id: string
  ): Promise<{ ok?: boolean; canceled?: boolean; error?: string }> =>
    ipcRenderer.invoke('reel:save', id),
  prepareSession: (id: string): Promise<SessionMeta | null> =>
    ipcRenderer.invoke('session:prepare', id),
  renameSession: (id: string, title: string): Promise<SessionMeta | null> =>
    ipcRenderer.invoke('session:rename', id, title),
  exportSession: (
    id: string,
    kind: 'transcript' | 'notes' | 'study' | 'overview'
  ): Promise<{ ok?: boolean; canceled?: boolean; error?: string }> =>
    ipcRenderer.invoke('session:export', id, kind),
  getExportText: (
    id: string,
    kind: 'transcript' | 'notes' | 'study' | 'overview'
  ): Promise<string | null> => ipcRenderer.invoke('session:exportText', id, kind),
  finalizeSession: (id: string, durationMs: number): Promise<SessionMeta | null> =>
    ipcRenderer.invoke('session:finalize', id, durationMs),

  transcribeChunk: (
    id: string,
    chunk: ArrayBuffer,
    offsetSec: number
  ): Promise<TranscribeResult> =>
    ipcRenderer.invoke('transcribe:chunk', id, chunk, offsetSec),

  askAi: (req: AskRequest): Promise<void> => ipcRenderer.invoke('ai:ask', req),

  askBrain: (req: BrainAskRequest): Promise<void> => ipcRenderer.invoke('brain:ask', req),
  searchLibrary: (query: string): Promise<BrainSearchHit[]> =>
    ipcRenderer.invoke('brain:search', query),
  brainStats: (): Promise<BrainStats> => ipcRenderer.invoke('brain:stats'),
  listBrainChats: (): Promise<BrainConversation[]> =>
    ipcRenderer.invoke('brain:listChats'),
  saveBrainChat: (conv: BrainConversation): Promise<void> =>
    ipcRenderer.invoke('brain:saveChat', conv),
  deleteBrainChat: (id: string): Promise<void> =>
    ipcRenderer.invoke('brain:deleteChat', id),

  startConference: (sessionId: string): Promise<{ url?: string; error?: string }> =>
    ipcRenderer.invoke('conference:start', sessionId),
  stopConference: (): Promise<void> => ipcRenderer.invoke('conference:stop'),
  pushStageFrame: (dataUrl: string): Promise<void> =>
    ipcRenderer.invoke('conference:frame', dataUrl),
  conferenceStatus: (): Promise<{
    running: boolean
    url?: string
    ended?: boolean
    attendees?: number
    questions?: { topic: string; items: { text: string; at: number; votes?: number }[] }[]
    reactions?: { landed: number; lost: number; recentLost: number }
    poll?: {
      id: string
      question: string
      options: string[]
      counts: number[]
      total: number
      status: 'open' | 'closed'
    }
  }> => ipcRenderer.invoke('conference:status'),
  launchPoll: (question: string, options: string[]): Promise<{ error?: string }> =>
    ipcRenderer.invoke('conference:launchPoll', question, options),
  closePoll: (): Promise<void> => ipcRenderer.invoke('conference:closePoll'),
  publishReplay: (
    sessionId: string,
    enable: boolean
  ): Promise<{ url?: string; enabled?: boolean; error?: string }> =>
    ipcRenderer.invoke('replay:publish', sessionId, enable),
  // ---------- memory (decisions, promises, people, concepts) ----------
  listMemory: (): Promise<MemoryObject[]> => ipcRenderer.invoke('memory:list'),
  updateMemory: (
    id: string,
    patch: { status?: 'open' | 'changed' | 'done' }
  ): Promise<MemoryObject | null> => ipcRenderer.invoke('memory:update', id, patch),
  deleteMemory: (id: string): Promise<void> => ipcRenderer.invoke('memory:delete', id),
  roomMind: (
    sessionId: string
  ): Promise<{ themes: { topic: string; count: number }[]; error?: string }> =>
    ipcRenderer.invoke('room:mind', sessionId),
  roomRecap: (sessionId: string, topic: string): Promise<{ text?: string; error?: string }> =>
    ipcRenderer.invoke('room:recap', sessionId, topic),
  pushRoomNote: (text: string): Promise<{ error?: string }> =>
    ipcRenderer.invoke('room:pushNote', text),
  // ---------- coach ----------
  listCoachProjects: (): Promise<CoachProject[]> => ipcRenderer.invoke('coach:list'),
  createCoachProject: (
    title: string,
    goal: string,
    audience: string,
    when: number | null
  ): Promise<CoachProject> => ipcRenderer.invoke('coach:create', title, goal, audience, when),
  updateCoachProject: (
    id: string,
    patch: { eventId?: string | null; when?: number | null }
  ): Promise<CoachProject | null> => ipcRenderer.invoke('coach:update', id, patch),
  deleteCoachProject: (id: string): Promise<void> => ipcRenderer.invoke('coach:delete', id),
  coachAddMaterialFile: (
    id: string
  ): Promise<{ project?: CoachProject; canceled?: boolean; error?: string }> =>
    ipcRenderer.invoke('coach:addMaterialFile', id),
  coachAddMaterialText: (
    id: string,
    name: string,
    text: string
  ): Promise<{ project?: CoachProject; error?: string }> =>
    ipcRenderer.invoke('coach:addMaterialText', id, name, text),
  coachRemoveMaterial: (
    id: string,
    index: number
  ): Promise<{ project?: CoachProject; error?: string }> =>
    ipcRenderer.invoke('coach:removeMaterial', id, index),
  coachBrief: (id: string): Promise<{ project?: CoachProject; error?: string }> =>
    ipcRenderer.invoke('coach:brief', id),
  coachStt: (chunk: ArrayBuffer, offsetSec: number): Promise<TranscribeResult> =>
    ipcRenderer.invoke('coach:stt', chunk, offsetSec),
  coachScore: (
    id: string,
    segments: TranscriptSegment[],
    durationSec: number
  ): Promise<{ rehearsal?: CoachRehearsal; project?: CoachProject; error?: string }> =>
    ipcRenderer.invoke('coach:score', id, segments, durationSec),
  coachSimAsk: (req: {
    projectId: string
    requestId: string
    persona: string
    difficulty: SimDifficulty
    question: string
    history: ChatMessage[]
  }): Promise<void> => ipcRenderer.invoke('coach:simAsk', req),
  coachHint: (id: string, segments: TranscriptSegment[]): Promise<{ hint?: string }> =>
    ipcRenderer.invoke('coach:hint', id, segments),
  coachGetSim: (id: string): Promise<ChatMessage[]> => ipcRenderer.invoke('coach:getSim', id),
  coachSaveSim: (id: string, chat: ChatMessage[]): Promise<void> =>
    ipcRenderer.invoke('coach:saveSim', id, chat),

  listEvents: (): Promise<{
    events: ScheduledEvent[]
    status: { running: boolean; url?: string; waiting?: boolean; eventId?: string }
  }> => ipcRenderer.invoke('events:list'),
  createEvent: (
    title: string,
    startsAt: number | null,
    agenda: string[]
  ): Promise<{ url?: string; event?: ScheduledEvent; error?: string }> =>
    ipcRenderer.invoke('events:create', title, startsAt, agenda),
  updateEvent: (
    id: string,
    patch: {
      title?: string
      startsAt?: number | null
      agenda?: string[]
      preEventChat?: boolean
      liveVoice?: { enabled: boolean; languages: string[] }
    }
  ): Promise<ScheduledEvent | null> => ipcRenderer.invoke('events:update', id, patch),
  deleteEvent: (id: string): Promise<void> => ipcRenderer.invoke('events:delete', id),
  armEvent: (id: string): Promise<{ url?: string; error?: string }> =>
    ipcRenderer.invoke('events:arm', id),
  addMaterialFile: (
    id: string
  ): Promise<{ event?: ScheduledEvent; canceled?: boolean; error?: string }> =>
    ipcRenderer.invoke('events:addMaterialFile', id),
  addMaterialText: (
    id: string,
    name: string,
    text: string
  ): Promise<{ event?: ScheduledEvent; error?: string }> =>
    ipcRenderer.invoke('events:addMaterialText', id, name, text),
  removeMaterial: (
    id: string,
    index: number
  ): Promise<{ event?: ScheduledEvent; error?: string }> =>
    ipcRenderer.invoke('events:removeMaterial', id, index),
  saveQr: (
    dataUrl: string,
    title: string
  ): Promise<{ ok?: boolean; canceled?: boolean; error?: string }> =>
    ipcRenderer.invoke('event:saveQr', dataUrl, title),
  onConferenceUpdate: (cb: () => void): (() => void) => {
    const listener = (): void => cb()
    ipcRenderer.on('conference:update', listener)
    return () => ipcRenderer.removeListener('conference:update', listener)
  },

  checkNudge: (
    id: string,
    userQuestions: string[],
    priorNudges: string[]
  ): Promise<{ nudge?: string }> =>
    ipcRenderer.invoke('nudge:check', id, userQuestions, priorNudges),

  updateNotes: (id: string): Promise<{ notes?: SessionNotes | null; error?: string }> =>
    ipcRenderer.invoke('notes:update', id),
  generateStudy: (id: string): Promise<{ study?: StudyPack; error?: string }> =>
    ipcRenderer.invoke('study:generate', id),

  onAiStream: (cb: (event: AiStreamEvent) => void): (() => void) => {
    const listener = (_e: Electron.IpcRendererEvent, payload: AiStreamEvent): void =>
      cb(payload)
    ipcRenderer.on('ai:stream', listener)
    return () => ipcRenderer.removeListener('ai:stream', listener)
  },

  onSessionUpdated: (cb: (meta: SessionMeta) => void): (() => void) => {
    const listener = (_e: Electron.IpcRendererEvent, meta: SessionMeta): void => cb(meta)
    ipcRenderer.on('session:updated', listener)
    return () => ipcRenderer.removeListener('session:updated', listener)
  }
}

export type SitkaApi = typeof api

contextBridge.exposeInMainWorld('sitka', api)
