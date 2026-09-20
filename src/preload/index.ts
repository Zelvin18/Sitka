import { contextBridge, ipcRenderer } from 'electron'
import type { Usage } from '../shared/plans'
import type {
  AiStreamEvent,
  AskRequest,
  BrainAskRequest,
  BrainConversation,
  BrainSearchHit,
  BrainStats,
  CoachProject,
  CoachRehearsal,
  CreateRequest,
  Creation,
  EventReport,
  Slide,
  MemoryObject,
  OrgMember,
  OrgSpace,
  OrgSpaceKind,
  Organization,
  Profile,
  RoomMessage,
  ScheduledEvent,
  Space,
  SpaceAskRequest,
  SpaceInsight,
  SpaceMaterial,
  SimDifficulty,
  Speaker,
  TranscriptSegment,
  CaptureSource,
  ChatMessage,
  SessionData,
  SessionMaterial,
  SessionMeta,
  SessionNotes,
  Settings,
  StudyPack,
  TranscribeResult
} from '@shared/types'

const api = {
  getSettings: (): Promise<Settings> => ipcRenderer.invoke('settings:get'),
  getProfile: (): Promise<Profile> => ipcRenderer.invoke('profile:get'),
  /** A word on an answer, right or wrong, kept with its question for the people who run Sitca. */
  rateAnswer: (sessionId: string, question: string, answer: string, good: boolean): Promise<void> =>
    ipcRenderer.invoke('answer:rate', sessionId, question, answer, good),
  /** The brief Sitca writes for sharing, as a page (HTML) and as markdown. */
  sessionBrief: (id: string): Promise<{ html?: string; title?: string; markdown?: string; error?: string }> =>
    ipcRenderer.invoke('session:brief', id),
  /** The session into the person's Google Drive: the recording and a Google Doc. Progress arrives as the 'sitka:drive' window event. */
  saveToDrive: (id: string): Promise<{ folderUrl?: string; fileUrl?: string; docUrl?: string; error?: string }> =>
    ipcRenderer.invoke('drive:save', id),
  /** This month against the plan: hours, questions, storage. null where there is no plan (the desktop's own workspace). */
  getUsage: (force?: boolean): Promise<Usage | null> => ipcRenderer.invoke('usage:get', Boolean(force)),
  /** what the person is called; null when nothing was given */
  setProfileName: (name: string): Promise<Profile | null> => ipcRenderer.invoke('profile:set', name),
  /** the welcome has been shown: it is not shown again for this account */
  markWelcomed: (): Promise<void> => ipcRenderer.invoke('profile:welcomed'),
  /** Online: sign out and return to the gate. Desktop: nothing to sign out of. */
  signOut: (): Promise<void> => ipcRenderer.invoke('profile:signOut'),
  /** the online account and everything in it, gone for good; the desktop's local workspace has no account to delete */
  deleteAccount: (confirmEmail: string): Promise<{ ok?: boolean; error?: string }> =>
    ipcRenderer.invoke('profile:deleteAccount', confirmEmail),
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
    space?: 'business' | 'education',
    audioOnly?: boolean,
    spaceId?: string
  ): Promise<SessionMeta> =>
    ipcRenderer.invoke('session:create', title, kind, hosted, agenda, eventId, space, audioOnly, spaceId),

  // ---------- organisations (online workspace) ----------
  listOrgs: (): Promise<Organization[]> => ipcRenderer.invoke('org:list'),
  createOrg: (name: string, kind: Space): Promise<{ org?: Organization; error?: string }> =>
    ipcRenderer.invoke('org:create', name, kind),
  joinOrg: (code: string): Promise<{ org?: Organization; error?: string }> =>
    ipcRenderer.invoke('org:join', code),
  leaveOrg: (orgId: string): Promise<void> => ipcRenderer.invoke('org:leave', orgId),
  /** the owner removes the organisation for everyone: its spaces and materials go with it, sessions stay with whoever recorded them */
  deleteOrg: (orgId: string): Promise<{ error?: string }> => ipcRenderer.invoke('org:delete', orgId),
  listOrgMembers: (orgId: string): Promise<OrgMember[]> => ipcRenderer.invoke('org:members', orgId),
  listSpaces: (orgId: string): Promise<OrgSpace[]> => ipcRenderer.invoke('org:spaces', orgId),
  createSpace: (
    orgId: string,
    name: string,
    kind: OrgSpaceKind,
    description: string
  ): Promise<{ space?: OrgSpace; error?: string }> =>
    ipcRenderer.invoke('org:createSpace', orgId, name, kind, description),
  deleteSpace: (spaceId: string): Promise<void> => ipcRenderer.invoke('org:deleteSpace', spaceId),
  listSpaceMaterials: (spaceId: string): Promise<SpaceMaterial[]> =>
    ipcRenderer.invoke('org:materials', spaceId),
  addSpaceMaterial: (spaceId: string, name: string, text: string): Promise<SpaceMaterial[]> =>
    ipcRenderer.invoke('org:addMaterial', spaceId, name, text),
  removeSpaceMaterial: (spaceId: string, materialId: string): Promise<SpaceMaterial[]> =>
    ipcRenderer.invoke('org:removeMaterial', spaceId, materialId),
  listSpaceSessions: (spaceId: string): Promise<SessionMeta[]> =>
    ipcRenderer.invoke('org:spaceSessions', spaceId),
  assignSessionToSpace: (sessionId: string, spaceId: string | null): Promise<void> =>
    ipcRenderer.invoke('org:assignSession', sessionId, spaceId),
  askSpace: (req: SpaceAskRequest): Promise<void> => ipcRenderer.invoke('org:ask', req),
  spaceInsights: (spaceId: string): Promise<SpaceInsight[]> =>
    ipcRenderer.invoke('org:insights', spaceId),
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
  /** links to the recording's parts, in order, for streaming playback; [] when it must be read whole */
  listVideoParts: (id: string): Promise<string[]> => ipcRenderer.invoke('session:videoParts', id),
  /** the same parts with their sizes, which lets the player jump about in them */
  listVideoPartsSized: (id: string): Promise<{ url: string; size: number }[]> => ipcRenderer.invoke('session:videoPartsSized', id),
  /** a link to the recording as one whole file, playable natively; null when there is none yet */
  videoUrl: (id: string): Promise<string | null> => ipcRenderer.invoke('session:videoUrl', id),
  /** re-record an older WebM recording as MP4 so phones can play it; progress arrives on window 'sitka:convert' */
  convertForPhones: (id: string): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke('session:convertForPhones', id),
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
  /** the picture shown in place of video for an audio session (a JPEG data URL), or null to clear it */
  /** a lead takes someone else's session out of a space (the session itself stays with its owner) */
  unfileSpaceSession: (id: string): Promise<void> => ipcRenderer.invoke('space:unfile', id),
  /** a recap someone shared, kept in this library (an online feature; the desktop's local workspace has no shared recaps) */
  keepRecap: (id: string): Promise<{ ok?: boolean; error?: string }> => ipcRenderer.invoke('recap:keep', id),
  setSessionBanner: (id: string, banner: string | null): Promise<SessionMeta | null> =>
    ipcRenderer.invoke('session:banner', id, banner),
  exportSession: (
    id: string,
    kind: 'transcript' | 'notes' | 'study' | 'overview'
  ): Promise<{ ok?: boolean; canceled?: boolean; error?: string }> =>
    ipcRenderer.invoke('session:export', id, kind),
  getExportText: (
    id: string,
    kind: 'transcript' | 'notes' | 'study' | 'overview'
  ): Promise<string | null> => ipcRenderer.invoke('session:exportText', id, kind),
  createSampleSession: (): Promise<SessionMeta | null> =>
    ipcRenderer.invoke('session:sample'),
  /** Push any recording parts still on this device to the cloud (web). */
  retryUploads: (sessionId: string): Promise<{ pending: number }> =>
    ipcRenderer.invoke('session:retryUploads', sessionId),
  /** Re-run the title/summary/highlights analysis (after a failure). */
  reanalyzeSession: (id: string): Promise<SessionMeta | null> =>
    ipcRenderer.invoke('session:reanalyze', id),
  /** The session's record read afresh, for a page waiting on what another page writes. */
  refreshSession: (id: string): Promise<SessionMeta | null> =>
    ipcRenderer.invoke('session:prepare', id),
  finalizeSession: (id: string, durationMs: number): Promise<SessionMeta | null> =>
    ipcRenderer.invoke('session:finalize', id, durationMs),

  transcribeChunk: (
    id: string,
    chunk: ArrayBuffer,
    offsetSec: number,
    mime?: string
  ): Promise<TranscribeResult> =>
    ipcRenderer.invoke('transcribe:chunk', id, chunk, offsetSec, mime),

  askAi: (req: AskRequest): Promise<void> => ipcRenderer.invoke('ai:ask', req),
  /** a picture of a document (slide, page, whiteboard) read into text by the vision model */
  readImage: (dataUrl: string): Promise<{ text: string; error?: string }> => ipcRenderer.invoke('ai:readImage', dataUrl),

  // ---------- session materials: slides, notes, readings ----------
  listSessionMaterials: (sessionId: string): Promise<SessionMaterial[]> =>
    ipcRenderer.invoke('materials:list', sessionId),
  addSessionMaterial: (sessionId: string, name: string, text: string): Promise<SessionMaterial[]> =>
    ipcRenderer.invoke('materials:add', sessionId, name, text),
  removeSessionMaterial: (sessionId: string, materialId: string): Promise<SessionMaterial[]> =>
    ipcRenderer.invoke('materials:remove', sessionId, materialId),
  /** Turn a picked file (PDF, TXT, MD, CSV…) into text. */
  extractMaterial: (
    name: string,
    bytes: ArrayBuffer
  ): Promise<{ name: string; text: string } | { error: string }> =>
    ipcRenderer.invoke('materials:extract', name, bytes),

  // ---------- visual memory (key frames of the screen) ----------
  addSlide: (
    sessionId: string,
    time: number,
    dataUrl: string
  ): Promise<{ text: string; error?: string }> =>
    ipcRenderer.invoke('slides:add', sessionId, time, dataUrl),
  listSlides: (sessionId: string): Promise<Slide[]> =>
    ipcRenderer.invoke('slides:list', sessionId),

  // ---------- Create: documents, presentations, code ----------
  listCreations: (): Promise<Creation[]> => ipcRenderer.invoke('create:list'),
  saveCreation: (c: Creation): Promise<void> => ipcRenderer.invoke('create:save', c),
  deleteCreation: (id: string): Promise<void> => ipcRenderer.invoke('create:delete', id),
  generateCreation: (req: CreateRequest): Promise<{ creation?: Creation; error?: string }> =>
    ipcRenderer.invoke('create:generate', req),
  saveTextFile: (
    name: string,
    content: string
  ): Promise<{ ok?: boolean; canceled?: boolean; error?: string }> =>
    ipcRenderer.invoke('file:saveText', name, content),
  saveBinaryFile: (
    name: string,
    bytes: ArrayBuffer
  ): Promise<{ ok?: boolean; canceled?: boolean; error?: string }> =>
    ipcRenderer.invoke('file:saveBinary', name, bytes),

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
  /** hosted sessions: the room is told the event is over at once, before the recording is wound down */
  endEventNow: (id: string): Promise<void> => ipcRenderer.invoke('conference:end-now', id),
  /** live video to attendees — served by the web app; the desktop host uses stage frames */
  startVideoBroadcast: async (_stream: unknown): Promise<void> => undefined,
  stopVideoBroadcast: async (): Promise<void> => undefined,
  /** mirror the host's screen to every attendee; an error says why phones are not getting it */
  pushStageFrame: (dataUrl: string): Promise<{ error?: string } | void> =>
    ipcRenderer.invoke('conference:frame', dataUrl),
  conferenceStatus: (): Promise<{
    running: boolean
    url?: string
    ended?: boolean
    /** live but nobody has joined yet (cloud events) */
    waiting?: boolean
    /** the scheduled event this broadcast belongs to (cloud events) */
    eventId?: string
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
  /** the room chat of the live event: what attendees are saying to each other */
  listRoomMessages: (eventId?: string): Promise<RoomMessage[]> => ipcRenderer.invoke('room:list', eventId),
  /** The questions attendees sent the speaker, by topic, most asked first. */
  listSpeakerQuestions: (eventId: string): Promise<{ topic: string; items: { text: string; at: number; votes: number }[] }[]> =>
    ipcRenderer.invoke('room:questions', eventId),
  sendRoomMessage: (text: string): Promise<{ error?: string }> => ipcRenderer.invoke('room:send', text),
  publishReplay: (
    sessionId: string,
    enable: boolean
  ): Promise<{ url?: string; enabled?: boolean; error?: string }> =>
    ipcRenderer.invoke('replay:publish', sessionId, enable),
  /** Share any session as a public recap page (text only — the recording stays private). */
  publishRecap: (
    sessionId: string,
    enable: boolean
  ): Promise<{ url?: string; enabled?: boolean; error?: string }> =>
    ipcRenderer.invoke('recap:publish', sessionId, enable),
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
  coachStt: (chunk: ArrayBuffer, offsetSec: number, mime?: string): Promise<TranscribeResult> =>
    ipcRenderer.invoke('coach:stt', chunk, offsetSec, mime),
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
  /** the studio's audience: someone raises a hand with a question about what was just said */
  coachAudienceQuestion: (id: string, segments: TranscriptSegment[], asked: string[]): Promise<{ persona?: string; question?: string; error?: string }> =>
    ipcRenderer.invoke('coach:audienceQuestion', id, segments, asked),
  /** the studio's audience judges the spoken answer and says what a strong one would have been */
  coachJudgeAnswer: (
    id: string,
    persona: string,
    question: string,
    answer: string
  ): Promise<{ verdict?: 'strong' | 'needs-work' | 'weak'; reason?: string; strongAnswer?: string; spoken?: string; error?: string }> =>
    ipcRenderer.invoke('coach:judgeAnswer', id, persona, question, answer),
  coachGetSim: (id: string): Promise<ChatMessage[]> => ipcRenderer.invoke('coach:getSim', id),
  /** one's own conversation with a course or space, kept between visits */
  getSpaceChat: (spaceId: string): Promise<ChatMessage[]> => ipcRenderer.invoke('space:getChat', spaceId),
  saveSpaceChat: (spaceId: string, chat: ChatMessage[]): Promise<void> => ipcRenderer.invoke('space:saveChat', spaceId, chat),
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
  /** the event's banner (a JPEG data URL, or null to remove); id null = the event being hosted right now */
  setEventBanner: (id: string | null, dataUrl: string | null): Promise<ScheduledEvent | null> =>
    ipcRenderer.invoke('events:banner', id, dataUrl),
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
  /** Listen to the whole recording again and tell its voices apart; lines get their speaker. */
  identifySpeakers: (id: string): Promise<{ speakers?: Speaker[]; segments?: TranscriptSegment[]; error?: string }> =>
    ipcRenderer.invoke('speakers:identify', id),
  /** What a voice is called; an empty name clears it back to "Speaker N". */
  nameSpeaker: (id: string, speaker: number, name: string): Promise<{ speakers?: Speaker[]; error?: string }> =>
    ipcRenderer.invoke('speakers:name', id, speaker, name),
  /**
   * Captions that arrived from outside (a meeting's own live captions, with
   * the speaker's name): kept with the transcript, the names in the list of
   * speakers. Returns the speaker list so the caller can label its own lines.
   */
  addCaptions: (
    id: string,
    lines: { start: number; end: number; text: string; who?: string }[]
  ): Promise<{ speakers?: Speaker[]; segments?: TranscriptSegment[]; error?: string }> =>
    ipcRenderer.invoke('captions:add', id, lines),

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
