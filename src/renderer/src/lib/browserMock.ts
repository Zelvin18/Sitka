import type { SitkaApi } from '../../../preload/index'

/**
 * When the renderer is opened in a plain browser (UI preview) instead of
 * Electron, window.sitka does not exist. Install a harmless in-memory mock so
 * the interface can still be rendered and styled.
 */
export function installBrowserMockIfNeeded(): void {
  if ('sitka' in window) return
  const mock: SitkaApi = {
    getSettings: async () => ({
      anthropicApiKey: '',
      openaiApiKey: '',
      groqApiKey: '',
      supabaseUrl: '',
      supabaseServiceKey: '',
      webAppUrl: ''
    }),
    setSettings: async () => undefined,
    listSources: async () => [],
    getThumb: async () => null,
    createSession: async (title: string) => ({
      id: 'mock',
      title,
      createdAt: Date.now(),
      durationMs: 0,
      status: 'recording' as const
    }),
    listSessions: async () => [],
    getSession: async () => null,
    deleteSession: async () => undefined,
    saveChat: async () => undefined,
    appendChunk: async () => undefined,
    finalizeSession: async () => null,
    transcribeChunk: async () => ({ error: 'missing-key' }),
    readVideo: async () => null,
    setRecordingState: async () => undefined,
    markNow: async () => undefined,
    onSessionMarked: () => () => undefined,
    generateReel: async () => ({ error: 'unavailable in browser preview' }),
    saveReel: async () => ({ error: 'unavailable in browser preview' }),
    prepareSession: async () => null,
    renameSession: async () => null,
    exportSession: async () => ({ error: 'unavailable in browser preview' }),
    getExportText: async () => null,
    askAi: async () => undefined,
    askBrain: async () => undefined,
    searchLibrary: async () => [],
    brainStats: async () => ({ sessions: 0, totalMs: 0, words: 0, moments: 0 }),
    listBrainChats: async () => [],
    saveBrainChat: async () => undefined,
    deleteBrainChat: async () => undefined,
    startConference: async () => ({ error: 'unavailable in browser preview' }),
    stopConference: async () => undefined,
    pushStageFrame: async () => undefined,
    conferenceStatus: async () => ({ running: false }),
    onConferenceUpdate: () => () => undefined,
    listCoachProjects: async () => [],
    createCoachProject: async (title: string) => ({
      id: 'mock',
      title,
      goal: '',
      audience: '',
      createdAt: Date.now(),
      rehearsals: []
    }),
    updateCoachProject: async () => null,
    deleteCoachProject: async () => undefined,
    coachAddMaterialFile: async () => ({ error: 'unavailable in browser preview' }),
    coachAddMaterialText: async () => ({ error: 'unavailable in browser preview' }),
    coachRemoveMaterial: async () => ({ error: 'unavailable in browser preview' }),
    coachBrief: async () => ({ error: 'missing-key' }),
    coachStt: async () => ({ error: 'missing-key' }),
    coachScore: async () => ({ error: 'missing-key' }),
    coachSimAsk: async () => undefined,
    coachHint: async () => ({}),
    coachGetSim: async () => [],
    coachSaveSim: async () => undefined,
    listEvents: async () => ({ events: [], status: { running: false } }),
    createEvent: async () => ({ error: 'unavailable in browser preview' }),
    updateEvent: async () => null,
    deleteEvent: async () => undefined,
    armEvent: async () => ({ error: 'unavailable in browser preview' }),
    addMaterialFile: async () => ({ error: 'unavailable in browser preview' }),
    addMaterialText: async () => ({ error: 'unavailable in browser preview' }),
    removeMaterial: async () => ({ error: 'unavailable in browser preview' }),
    saveQr: async () => ({ error: 'unavailable in browser preview' }),
    checkNudge: async () => ({}),
    hostCoverage: async () => ({ covered: [] }),
    reportInsights: async () => ({ error: 'unavailable in browser preview' }),
    updateNotes: async () => ({ error: 'missing-key' }),
    generateStudy: async () => ({ error: 'missing-key' }),
    onAiStream: () => () => undefined,
    onSessionUpdated: () => () => undefined
  }
  ;(window as unknown as { sitka: SitkaApi }).sitka = mock
}
