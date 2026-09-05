import {
  app,
  BrowserWindow,
  desktopCapturer,
  dialog,
  globalShortcut,
  ipcMain,
  protocol,
  shell
} from 'electron'
import { join } from 'path'
import { createReadStream, existsSync, statSync, promises as fsp } from 'fs'
import { Readable } from 'stream'
import type {
  AskRequest,
  BrainAskRequest,
  BrainConversation,
  ChatMessage,
  EventReport,
  Settings
} from '@shared/types'
import {
  brainSystemPrompt,
  buildBrainContext,
  libraryStats,
  priorLearningContext,
  searchLibrary
} from './brain'
import {
  checkCoverage,
  completeText,
  detectNudge,
  extractJson,
  hostSystemPrompt,
  streamChatGeneric,
  transcriptBlock
} from './ai'
import * as store from './store'
import { remuxSession } from './remux'
import { generateReel } from './reel'
import { ensureThumb } from './thumbs'
import {
  conferenceStatus,
  configureConference,
  endConference,
  notifySegments,
  startConference,
  startWaitingEvent,
  stopConference,
  updateFrame
} from './conference'
import {
  cloudClosePoll,
  cloudConfigured,
  cloudLaunchPoll,
  cloudPublishReplay,
  cloudPushRoomNote,
  cloudRoomMind,
  cloudRoomRecap,
  cloudStatus,
  configureCloud,
  endCloudEvent,
  goLiveCloud,
  isCloudActive,
  notifyCloudSegments,
  startCloudWaiting,
  stopCloud,
  syncCloudEvent,
  updateCloudFrame
} from './cloud'
import { randomUUID } from 'crypto'
import { extractMaterialText } from './materials'
import { deleteMemoryObject, loadMemory, rememberSession, updateMemoryObject } from './memory'
import {
  buildBrief,
  liveCoachHint,
  practiceContext,
  scoreRehearsal,
  simSystemPrompt
} from './coach'
import { buildExport, type ExportKind } from './exportContent'
import {
  analyzeSession,
  analyzeSessionGroq,
  generateStudyPack,
  streamAsk,
  streamAskGroq,
  transcribeChunk,
  updateNotes
} from './ai'

protocol.registerSchemesAsPrivileged([
  {
    scheme: 'sitka',
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      stream: true,
      bypassCSP: true
    }
  }
])

let mainWindow: BrowserWindow | null = null

// Set while a live session records — powers the global "mark this" hotkey.
let currentRecording: { id: string; startedAt: number } | null = null

function markCurrentMoment(): void {
  if (!currentRecording) return
  const seconds = (Date.now() - currentRecording.startedAt) / 1000
  store.addMark(currentRecording.id, seconds)
  mainWindow?.webContents.send('session:marked', {
    sessionId: currentRecording.id,
    time: Math.round(seconds)
  })
}

function setRecording(state: { id: string; startedAt: number } | null): void {
  currentRecording = state
  globalShortcut.unregister('CommandOrControl+Shift+M')
  if (state) {
    globalShortcut.register('CommandOrControl+Shift+M', markCurrentMoment)
  }
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1360,
    height: 860,
    minWidth: 1000,
    minHeight: 640,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: '#ffffff',
    titleBarStyle: 'hidden',
    titleBarOverlay: {
      color: '#00000000',
      symbolColor: '#8a8a8e',
      height: 40
    },
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true
    }
  })

  mainWindow.on('ready-to-show', () => mainWindow?.show())

  mainWindow.webContents.setWindowOpenHandler((details) => {
    void shell.openExternal(details.url)
    return { action: 'deny' }
  })

  if (!app.isPackaged && process.env['ELECTRON_RENDERER_URL']) {
    void mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    void mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

app.whenReady().then(() => {
  // Serves session media to the renderer with full byte-range support, so the
  // <video> element can seek anywhere: sitka://sessions/<id>/video.webm
  protocol.handle('sitka', (request) => {
    const url = new URL(request.url)
    if (url.host !== 'sessions') return new Response('Not found', { status: 404 })
    const parts = url.pathname.split('/').filter(Boolean)
    const [id, file] = parts
    if (!id || file !== 'video.webm') return new Response('Not found', { status: 404 })
    const filePath = store.videoPath(id)
    if (!existsSync(filePath)) return new Response('Not found', { status: 404 })

    const total = statSync(filePath).size
    const range = request.headers.get('range')
    if (range) {
      const m = range.match(/bytes=(\d*)-(\d*)/)
      let start = m && m[1] ? parseInt(m[1], 10) : 0
      let end = m && m[2] ? parseInt(m[2], 10) : total - 1
      if (!Number.isFinite(start)) start = 0
      if (!Number.isFinite(end) || end >= total) end = total - 1
      if (start >= total || start > end) {
        return new Response(null, {
          status: 416,
          headers: { 'Content-Range': `bytes */${total}` }
        })
      }
      const stream = Readable.toWeb(
        createReadStream(filePath, { start, end })
      ) as unknown as ReadableStream
      return new Response(stream, {
        status: 206,
        headers: {
          'Content-Range': `bytes ${start}-${end}/${total}`,
          'Accept-Ranges': 'bytes',
          'Content-Length': String(end - start + 1),
          'Content-Type': 'video/webm'
        }
      })
    }
    const stream = Readable.toWeb(
      createReadStream(filePath)
    ) as unknown as ReadableStream
    return new Response(stream, {
      headers: {
        'Accept-Ranges': 'bytes',
        'Content-Length': String(total),
        'Content-Type': 'video/webm'
      }
    })
  })

  const aiKeys = (): { anthropicApiKey: string; groqApiKey: string } => {
    const { anthropicApiKey, groqApiKey } = store.getSettings()
    return { anthropicApiKey, groqApiKey }
  }
  const pingHost = (): void => mainWindow?.webContents.send('conference:update')
  configureConference(aiKeys, pingHost)
  configureCloud(aiKeys, pingHost)

  registerIpc()
  createWindow()

  // Re-arm the waiting server for the next still-relevant scheduled event.
  const nextEvent = store
    .listEvents()
    .find(
      (ev) =>
        !ev.sessionId &&
        (ev.startsAt === undefined || ev.startsAt > Date.now() - 12 * 3600000)
    )
  if (nextEvent) {
    if (cloudConfigured()) void startCloudWaiting(nextEvent)
    else void startWaitingEvent(nextEvent)
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('will-quit', () => {
  globalShortcut.unregisterAll()
  void stopConference()
})

function registerIpc(): void {
  ipcMain.handle('settings:get', () => store.getSettings())
  ipcMain.handle('settings:set', (_e, settings: Settings) => store.setSettings(settings))

  ipcMain.handle('sources:list', async () => {
    const sources = await desktopCapturer.getSources({
      types: ['screen', 'window'],
      thumbnailSize: { width: 480, height: 300 },
      fetchWindowIcons: false
    })
    return sources
      .filter((s) => s.thumbnail && !s.thumbnail.isEmpty())
      .map((s) => ({
        id: s.id,
        name: s.name,
        thumbnail: s.thumbnail.toDataURL(),
        kind: s.id.startsWith('screen') ? 'screen' : 'window'
      }))
  })

  ipcMain.handle(
    'session:create',
    (
      _e,
      title: string,
      kind?: 'lecture' | 'meeting' | 'presentation' | 'other',
      hosted?: boolean,
      agenda?: string[],
      eventId?: string,
      space?: 'business' | 'education'
    ) => {
      const meta = store.createSession(title, kind, hosted, agenda)
      if (eventId) meta.eventId = eventId
      if (space) meta.space = space
      if (eventId || space) store.saveMeta(meta)
      return meta
    }
  )

  ipcMain.handle('host:coverage', async (_e, id: string) => {
    const { anthropicApiKey, groqApiKey } = store.getSettings()
    const agenda = store.getMeta(id)?.agenda ?? []
    if (agenda.length === 0 || (!anthropicApiKey && !groqApiKey)) return { covered: [] }
    try {
      const covered = await checkCoverage(
        { anthropicApiKey, groqApiKey },
        store.getTranscript(id),
        agenda
      )
      return { covered }
    } catch {
      return { covered: [] }
    }
  })

  ipcMain.handle('report:insights', async (_e, id: string) => {
    const { anthropicApiKey, groqApiKey } = store.getSettings()
    if (!anthropicApiKey && !groqApiKey) return { error: 'missing-key' }
    const report = store.getReport(id)
    if (!report) return { error: 'No event report for this session.' }
    try {
      const segments = store.getTranscript(id)
      const system = [
        'You write the insights section of a post-event report for the HOST of a live event, from its transcript and audience data.',
        'Return ONLY JSON:',
        '{"overview": string, "coverage": [{"topic": string, "covered": boolean, "note": string}], "followUps": [string]}',
        '- overview: 2-4 sentences on how the event went, grounded in the data (attendance, questions, themes).',
        '- coverage: one entry per planned topic (in order) — covered or not, with a short note (e.g. where, or why it seems missed). Empty array if no planned topics.',
        '- followUps: 3-6 concrete follow-up actions for the host (unanswered question themes to address, material to send out, topics to revisit).'
      ].join('\n')
      const user = [
        `Attendance: ${report.joined} joined, peak ${report.peak}, ${report.aiAsks} private AI questions.`,
        report.agenda?.length
          ? `Planned topics:\n${report.agenda.map((a, i) => `${i + 1}. ${a}`).join('\n')}`
          : 'No planned topics.',
        report.questions.length > 0
          ? `Questions submitted (by topic):\n${report.questions
              .map((g) => `${g.topic}: ${g.items.map((q) => q.text).join(' | ')}`)
              .join('\n')}`
          : 'No questions were submitted.',
        '',
        'Transcript:',
        transcriptBlock(segments)
      ].join('\n')
      const text = await completeText({ anthropicApiKey, groqApiKey }, system, user)
      const parsed = extractJson<EventReport['insights']>(text)
      if (!parsed || typeof parsed.overview !== 'string') {
        return { error: 'Could not generate insights — try again.' }
      }
      report.insights = {
        overview: parsed.overview,
        coverage: Array.isArray(parsed.coverage)
          ? parsed.coverage.filter(
              (c) => c && typeof c.topic === 'string' && typeof c.covered === 'boolean'
            )
          : [],
        followUps: Array.isArray(parsed.followUps) ? parsed.followUps.map(String) : []
      }
      store.saveReport(id, report)
      return { report }
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) }
    }
  })
  ipcMain.handle('session:list', () => store.listSessions())
  ipcMain.handle('session:get', (_e, id: string) => store.getSessionData(id))
  ipcMain.handle('session:delete', (_e, id: string) => store.deleteSession(id))
  ipcMain.handle('session:saveChat', (_e, id: string, chat: ChatMessage[]) =>
    store.saveChat(id, chat)
  )

  ipcMain.handle('session:appendChunk', async (_e, id: string, chunk: ArrayBuffer) => {
    await store.appendVideoChunk(id, Buffer.from(chunk))
  })

  ipcMain.handle(
    'session:readVideo',
    async (_e, id: string, file: 'video' | 'reel' = 'video') => {
      try {
        const path = file === 'reel' ? store.reelPath(id) : store.videoPath(id)
        return await fsp.readFile(path)
      } catch {
        return null
      }
    }
  )

  // ---------- live recording state + marks ----------

  ipcMain.handle(
    'session:recordingState',
    (_e, state: { id: string; startedAt: number } | null) => setRecording(state)
  )
  ipcMain.handle('session:markNow', () => markCurrentMoment())

  // ---------- highlight reel ----------

  ipcMain.handle('reel:generate', async (_e, id: string) => {
    const result = await generateReel(id)
    if (!result.error) {
      const meta = store.getMeta(id)
      if (meta) mainWindow?.webContents.send('session:updated', meta)
    }
    return result
  })

  ipcMain.handle('reel:save', async (_e, id: string) => {
    const meta = store.getMeta(id)
    if (!meta || !existsSync(store.reelPath(id))) return { error: 'No reel yet.' }
    const safeTitle = meta.title.replace(/[\\/:*?"<>|]+/g, '').slice(0, 60).trim()
    const result = await dialog.showSaveDialog({
      title: 'Save highlight reel',
      defaultPath: `${safeTitle || 'session'} — highlights.webm`,
      filters: [{ name: 'WebM video', extensions: ['webm'] }]
    })
    if (result.canceled || !result.filePath) return { canceled: true }
    try {
      await fsp.copyFile(store.reelPath(id), result.filePath)
      return { ok: true }
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) }
    }
  })

  // ---------- Coach ----------

  const aiKeys = (): { anthropicApiKey: string; groqApiKey: string } => {
    const { anthropicApiKey, groqApiKey } = store.getSettings()
    return { anthropicApiKey, groqApiKey }
  }
  const hasAiKey = (): boolean => {
    const k = aiKeys()
    return Boolean(k.anthropicApiKey || k.groqApiKey)
  }

  ipcMain.handle('coach:list', () => store.listCoachProjects())

  ipcMain.handle(
    'coach:create',
    (_e, title: string, goal: string, audience: string, when: number | null) => {
      const project = {
        id: randomUUID(),
        title: title.trim() || 'Untitled practice',
        goal: goal.trim(),
        audience: audience.trim() || 'General audience',
        when: when ?? undefined,
        createdAt: Date.now(),
        rehearsals: []
      }
      store.saveCoachProject(project)
      return project
    }
  )

  ipcMain.handle(
    'coach:update',
    (_e, id: string, patch: { eventId?: string | null; when?: number | null }) => {
      const project = store.getCoachProject(id)
      if (!project) return null
      if (patch.eventId !== undefined) project.eventId = patch.eventId ?? undefined
      if (patch.when !== undefined) project.when = patch.when ?? undefined
      store.saveCoachProject(project)
      return project
    }
  )

  ipcMain.handle('coach:delete', (_e, id: string) => store.deleteCoachProject(id))

  ipcMain.handle('coach:addMaterialFile', async (_e, id: string) => {
    const project = store.getCoachProject(id)
    if (!project) return { error: 'Project not found.' }
    const picked = await dialog.showOpenDialog({
      title: 'Add material',
      filters: [
        { name: 'Documents', extensions: ['pdf', 'txt', 'md', 'csv', 'json', 'vtt', 'srt'] }
      ],
      properties: ['openFile']
    })
    if (picked.canceled || picked.filePaths.length === 0) return { canceled: true }
    const result = await extractMaterialText(picked.filePaths[0])
    if ('error' in result) return { error: result.error }
    const materials = store.getCoachMaterials(id)
    materials.push(result)
    store.saveCoachMaterials(id, materials)
    project.materials = materials.map((m) => ({ name: m.name, chars: m.text.length }))
    store.saveCoachProject(project)
    return { project }
  })

  ipcMain.handle('coach:addMaterialText', (_e, id: string, name: string, text: string) => {
    const project = store.getCoachProject(id)
    if (!project || !text.trim()) return { error: 'Nothing to add.' }
    const materials = store.getCoachMaterials(id)
    materials.push({
      name: name.trim() || `Pasted notes ${materials.length + 1}`,
      text: text.slice(0, 200000)
    })
    store.saveCoachMaterials(id, materials)
    project.materials = materials.map((m) => ({ name: m.name, chars: m.text.length }))
    store.saveCoachProject(project)
    return { project }
  })

  ipcMain.handle('coach:removeMaterial', (_e, id: string, index: number) => {
    const project = store.getCoachProject(id)
    if (!project) return { error: 'Project not found.' }
    const materials = store.getCoachMaterials(id)
    materials.splice(index, 1)
    store.saveCoachMaterials(id, materials)
    project.materials = materials.map((m) => ({ name: m.name, chars: m.text.length }))
    store.saveCoachProject(project)
    return { project }
  })

  ipcMain.handle('coach:brief', async (_e, id: string) => {
    if (!hasAiKey()) return { error: 'missing-key' }
    const project = store.getCoachProject(id)
    if (!project) return { error: 'Project not found.' }
    try {
      const brief = await buildBrief(aiKeys(), project)
      if (!brief) return { error: 'Could not build the brief — try again.' }
      project.brief = brief
      store.saveCoachProject(project)
      return { project }
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) }
    }
  })

  ipcMain.handle('coach:stt', async (_e, chunk: ArrayBuffer, offsetSec: number) => {
    const { openaiApiKey, groqApiKey } = store.getSettings()
    const provider = openaiApiKey ? ('openai' as const) : ('groq' as const)
    const key = openaiApiKey || groqApiKey
    if (!key) return { error: 'missing-key' }
    try {
      const segments = await transcribeChunk(provider, key, Buffer.from(chunk), offsetSec)
      return { segments }
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) }
    }
  })

  ipcMain.handle(
    'coach:score',
    async (_e, id: string, segments: { start: number; end: number; text: string }[], durationSec: number) => {
      if (!hasAiKey()) return { error: 'missing-key' }
      const project = store.getCoachProject(id)
      if (!project) return { error: 'Project not found.' }
      try {
        const result = await scoreRehearsal(aiKeys(), project, segments, durationSec)
        if (!result) return { error: 'Not enough speech to score — try a longer run.' }
        const rehearsal = {
          id: randomUUID(),
          at: Date.now(),
          durationSec: Math.round(durationSec),
          ...result
        }
        project.rehearsals.push(rehearsal)
        store.saveCoachProject(project)
        return { rehearsal, project }
      } catch (err) {
        return { error: err instanceof Error ? err.message : String(err) }
      }
    }
  )

  ipcMain.handle(
    'coach:simAsk',
    async (
      e,
      req: {
        projectId: string
        requestId: string
        persona: string
        difficulty: 'friendly' | 'professional' | 'challenging' | 'grilling'
        question: string
        history: ChatMessage[]
      }
    ) => {
      const send = (payload: unknown): void => {
        if (!e.sender.isDestroyed()) e.sender.send('ai:stream', payload)
      }
      if (!hasAiKey()) {
        send({ requestId: req.requestId, type: 'error', error: 'missing-key' })
        return
      }
      const project = store.getCoachProject(req.projectId)
      if (!project) {
        send({ requestId: req.requestId, type: 'error', error: 'Project not found.' })
        return
      }
      try {
        await streamChatGeneric({
          keys: aiKeys(),
          system: simSystemPrompt(project, req.persona, req.difficulty),
          history: req.history,
          question: req.question,
          onDelta: (text) => send({ requestId: req.requestId, type: 'delta', text })
        })
        send({ requestId: req.requestId, type: 'done' })
      } catch (err) {
        send({
          requestId: req.requestId,
          type: 'error',
          error: err instanceof Error ? err.message : String(err)
        })
      }
    }
  )

  ipcMain.handle(
    'coach:hint',
    async (_e, id: string, segments: { start: number; end: number; text: string }[]) => {
      if (!hasAiKey()) return {}
      const project = store.getCoachProject(id)
      if (!project) return {}
      try {
        const hint = await liveCoachHint(aiKeys(), project, segments)
        return hint ? { hint } : {}
      } catch {
        return {}
      }
    }
  )

  ipcMain.handle('coach:getSim', (_e, id: string) => store.getCoachSim(id))
  ipcMain.handle('coach:saveSim', (_e, id: string, chat: ChatMessage[]) =>
    store.saveCoachSim(id, chat)
  )

  // ---------- Brain (cross-session) ----------

  ipcMain.handle('brain:search', (_e, query: string) => searchLibrary(query))
  ipcMain.handle('brain:stats', () => libraryStats())
  ipcMain.handle('brain:listChats', () => store.listBrainChats())
  ipcMain.handle('brain:saveChat', (_e, conv: BrainConversation) =>
    store.saveBrainConversation(conv)
  )
  ipcMain.handle('brain:deleteChat', (_e, id: string) =>
    store.deleteBrainConversation(id)
  )

  ipcMain.handle('brain:ask', async (e, req: BrainAskRequest) => {
    const { anthropicApiKey, groqApiKey } = store.getSettings()
    const send = (payload: unknown): void => {
      if (!e.sender.isDestroyed()) e.sender.send('ai:stream', payload)
    }
    if (!anthropicApiKey && !groqApiKey) {
      send({ requestId: req.requestId, type: 'error', error: 'missing-key' })
      return
    }
    try {
      const system = brainSystemPrompt(buildBrainContext(req.question))
      await streamChatGeneric({
        keys: { anthropicApiKey, groqApiKey },
        system,
        history: req.history,
        question: req.question,
        onDelta: (text) => send({ requestId: req.requestId, type: 'delta', text })
      })
      send({ requestId: req.requestId, type: 'done' })
    } catch (err) {
      send({
        requestId: req.requestId,
        type: 'error',
        error: err instanceof Error ? err.message : String(err)
      })
    }
  })

  ipcMain.handle(
    'nudge:check',
    async (_e, id: string, userQuestions: string[], priorNudges: string[]) => {
      const { anthropicApiKey, groqApiKey } = store.getSettings()
      if (!anthropicApiKey && !groqApiKey) return {}
      try {
        const nudge = await detectNudge(
          { anthropicApiKey, groqApiKey },
          store.getTranscript(id),
          userQuestions,
          priorNudges
        )
        return nudge ? { nudge } : {}
      } catch {
        return {}
      }
    }
  )

  ipcMain.handle('notes:update', async (_e, id: string) => {
    const { anthropicApiKey, groqApiKey } = store.getSettings()
    if (!anthropicApiKey && !groqApiKey) return { error: 'missing-key' }
    try {
      const segments = store.getTranscript(id)
      const previous = store.getNotes(id)
      const notes = await updateNotes({ anthropicApiKey, groqApiKey }, segments, previous)
      if (notes) {
        store.saveNotes(id, notes)
        return { notes }
      }
      if (previous) return { notes: previous }
      return { error: 'Could not generate notes this time — please try again.' }
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) }
    }
  })

  ipcMain.handle('study:generate', async (_e, id: string) => {
    const { anthropicApiKey, groqApiKey } = store.getSettings()
    if (!anthropicApiKey && !groqApiKey) return { error: 'missing-key' }
    try {
      const segments = store.getTranscript(id)
      const study = await generateStudyPack({ anthropicApiKey, groqApiKey }, segments)
      if (!study) return { error: 'Not enough transcript to build a study pack.' }
      store.saveStudy(id, study)
      return { study }
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) }
    }
  })

  ipcMain.handle('session:finalize', async (_e, id: string, durationMs: number) => {
    if (currentRecording?.id === id) setRecording(null)
    const meta = store.getMeta(id)
    if (!meta) return null
    meta.durationMs = durationMs
    meta.status = 'complete'
    if (await remuxSession(id)) meta.remuxed = true
    store.saveMeta(meta)
    endConference(id)
    endCloudEvent(id)
    void ensureThumb(id)
    void runAnalysis(id)
    return meta
  })

  // ---------- conference (live audience) ----------

  ipcMain.handle('conference:start', (_e, sessionId: string) => {
    // Event sessions go through the cloud relay when it is configured;
    // ad-hoc hosted sessions (no event) stay on the same-Wi-Fi server.
    const meta = store.getMeta(sessionId)
    if (meta?.eventId && cloudConfigured()) return goLiveCloud(sessionId, meta.eventId)
    return startConference(sessionId)
  })
  ipcMain.handle('conference:stop', async () => {
    stopCloud()
    await stopConference()
  })
  ipcMain.handle('conference:status', () =>
    isCloudActive() ? cloudStatus() : conferenceStatus()
  )
  ipcMain.handle('conference:frame', (_e, dataUrl: string) => {
    updateFrame(dataUrl)
    updateCloudFrame(dataUrl)
  })
  ipcMain.handle('conference:launchPoll', (_e, question: string, options: string[]) =>
    isCloudActive()
      ? cloudLaunchPoll(question, options)
      : { error: 'Live polls need an online (cloud) event.' }
  )
  ipcMain.handle('conference:closePoll', () => (isCloudActive() ? cloudClosePoll() : undefined))
  ipcMain.handle('replay:publish', (_e, sessionId: string, enable: boolean) =>
    cloudConfigured()
      ? cloudPublishReplay(sessionId, enable)
      : { error: 'Set up online events in Settings first.' }
  )
  ipcMain.handle('memory:list', () => loadMemory())
  ipcMain.handle(
    'memory:update',
    (_e, id: string, patch: { status?: 'open' | 'changed' | 'done' }) =>
      updateMemoryObject(id, patch)
  )
  ipcMain.handle('memory:delete', (_e, id: string) => deleteMemoryObject(id))
  ipcMain.handle('room:mind', (_e, sessionId: string) =>
    isCloudActive() ? cloudRoomMind(sessionId) : { themes: [] }
  )
  ipcMain.handle('room:recap', (_e, sessionId: string, topic: string) =>
    cloudConfigured() ? cloudRoomRecap(sessionId, topic) : { error: 'missing-key' }
  )
  ipcMain.handle('room:pushNote', (_e, text: string) =>
    isCloudActive() ? cloudPushRoomNote(text) : { error: 'Live notes need an online event.' }
  )

  // ---------- events (the hosting ecosystem) ----------

  ipcMain.handle('events:list', () => ({
    events: store.listEvents(),
    status: conferenceStatus()
  }))

  ipcMain.handle(
    'events:create',
    async (_e, title: string, startsAt: number | null, agenda: string[]) => {
      const event = {
        id: randomUUID(),
        title: title.trim() || 'Live event',
        startsAt: startsAt ?? undefined,
        agenda: agenda.filter(Boolean).slice(0, 12),
        createdAt: Date.now()
      }
      if (cloudConfigured()) {
        store.saveEvent(event)
        const res = await startCloudWaiting(event)
        if (res.error || !res.url) return { error: res.error ?? 'Could not reach Supabase.' }
        return { url: res.url, event }
      }
      const res = await startWaitingEvent(event)
      if (res.error || !res.url) {
        return { error: res.error ?? 'Could not start the event server.' }
      }
      const saved = { ...event, port: res.port }
      store.saveEvent(saved)
      return { url: res.url, event: saved }
    }
  )

  ipcMain.handle(
    'events:update',
    (
      _e,
      id: string,
      patch: {
        title?: string
        startsAt?: number | null
        agenda?: string[]
        preEventChat?: boolean
        liveVoice?: { enabled: boolean; languages: string[] }
      }
    ) => {
      const event = store.getEvent(id)
      if (!event) return null
      if (patch.title !== undefined) event.title = patch.title.trim() || event.title
      if (patch.startsAt !== undefined) event.startsAt = patch.startsAt ?? undefined
      if (patch.agenda !== undefined) event.agenda = patch.agenda.filter(Boolean).slice(0, 12)
      if (patch.preEventChat !== undefined) event.preEventChat = patch.preEventChat
      if (patch.liveVoice !== undefined) event.liveVoice = patch.liveVoice
      store.saveEvent(event)
      syncCloudEvent(id)
      return event
    }
  )

  ipcMain.handle('events:delete', async (_e, id: string) => {
    const status = conferenceStatus()
    if (status.running && status.waiting && status.eventId === id) await stopConference()
    const cs = cloudStatus()
    if (cs.running && cs.waiting && cs.eventId === id) stopCloud()
    store.deleteEvent(id)
  })

  // Arms (or re-arms) the waiting server + QR for one specific event.
  ipcMain.handle('events:arm', async (_e, id: string) => {
    const event = store.getEvent(id)
    if (!event) return { error: 'Event not found.' }
    if (cloudConfigured()) {
      const cloudRes = await startCloudWaiting(event)
      if (cloudRes.error || !cloudRes.url) {
        return { error: cloudRes.error ?? 'Could not reach Supabase.' }
      }
      return { url: cloudRes.url }
    }
    const res = await startWaitingEvent(event)
    if (res.error || !res.url) return { error: res.error ?? 'Could not start the server.' }
    if (event.port !== res.port) {
      event.port = res.port
      store.saveEvent(event)
    }
    return { url: res.url }
  })

  ipcMain.handle('events:addMaterialFile', async (_e, id: string) => {
    const event = store.getEvent(id)
    if (!event) return { error: 'Event not found.' }
    const picked = await dialog.showOpenDialog({
      title: 'Add event material',
      filters: [
        { name: 'Documents', extensions: ['pdf', 'txt', 'md', 'csv', 'json', 'vtt', 'srt'] }
      ],
      properties: ['openFile']
    })
    if (picked.canceled || picked.filePaths.length === 0) return { canceled: true }
    const result = await extractMaterialText(picked.filePaths[0])
    if ('error' in result) return { error: result.error }
    const materials = store.getMaterials(id)
    materials.push(result)
    store.saveMaterials(id, materials)
    event.materials = materials.map((m) => ({ name: m.name, chars: m.text.length }))
    store.saveEvent(event)
    return { event }
  })

  ipcMain.handle('events:addMaterialText', (_e, id: string, name: string, text: string) => {
    const event = store.getEvent(id)
    if (!event || !text.trim()) return { error: 'Nothing to add.' }
    const materials = store.getMaterials(id)
    materials.push({ name: name.trim() || `Pasted notes ${materials.length + 1}`, text: text.slice(0, 200000) })
    store.saveMaterials(id, materials)
    event.materials = materials.map((m) => ({ name: m.name, chars: m.text.length }))
    store.saveEvent(event)
    return { event }
  })

  ipcMain.handle('events:removeMaterial', (_e, id: string, index: number) => {
    const event = store.getEvent(id)
    if (!event) return { error: 'Event not found.' }
    const materials = store.getMaterials(id)
    materials.splice(index, 1)
    store.saveMaterials(id, materials)
    event.materials = materials.map((m) => ({ name: m.name, chars: m.text.length }))
    store.saveEvent(event)
    return { event }
  })

  ipcMain.handle('event:saveQr', async (_e, dataUrl: string, title: string) => {
    const m = dataUrl.match(/^data:image\/png;base64,(.+)$/)
    if (!m) return { error: 'Bad image data.' }
    const safe = title.replace(/[\\/:*?"<>|]+/g, '').slice(0, 60).trim()
    const result = await dialog.showSaveDialog({
      title: 'Save event QR code',
      defaultPath: `${safe || 'event'} — QR.png`,
      filters: [{ name: 'PNG image', extensions: ['png'] }]
    })
    if (result.canceled || !result.filePath) return { canceled: true }
    try {
      await fsp.writeFile(result.filePath, Buffer.from(m[1], 'base64'))
      return { ok: true }
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) }
    }
  })

  ipcMain.handle('session:thumb', async (_e, id: string) => {
    const path = await ensureThumb(id)
    if (!path) return null
    try {
      const buf = await fsp.readFile(path)
      return `data:image/jpeg;base64,${buf.toString('base64')}`
    } catch {
      return null
    }
  })

  // Lazily remux sessions recorded before ffmpeg support (or if it failed).
  ipcMain.handle('session:prepare', async (_e, id: string) => {
    const meta = store.getMeta(id)
    if (!meta) return null
    if (meta.status === 'complete' && !meta.remuxed) {
      if (await remuxSession(id)) {
        meta.remuxed = true
        store.saveMeta(meta)
      }
    }
    return meta
  })

  ipcMain.handle('session:rename', (_e, id: string, title: string) => {
    const meta = store.getMeta(id)
    if (!meta) return null
    const trimmed = title.trim()
    if (trimmed) {
      meta.title = trimmed
      store.saveMeta(meta)
      mainWindow?.webContents.send('session:updated', meta)
    }
    return meta
  })

  // Plain formatted text of a tab's content, for copy-to-clipboard.
  ipcMain.handle('session:exportText', (_e, id: string, kind: ExportKind) => {
    const data = store.getSessionData(id)
    return data ? buildExport(data, kind) : null
  })

  ipcMain.handle('session:export', async (_e, id: string, kind: ExportKind) => {
    const data = store.getSessionData(id)
    if (!data) return { error: 'Session not found.' }
    const content = buildExport(data, kind)
    if (!content) return { error: 'Nothing to export yet for this tab.' }
    const safeTitle = data.meta.title.replace(/[\\/:*?"<>|]+/g, '').slice(0, 60).trim()
    const result = await dialog.showSaveDialog({
      title: 'Export from Sitka',
      defaultPath: `${safeTitle || 'session'} — ${kind}.md`,
      filters: [{ name: 'Markdown', extensions: ['md'] }]
    })
    if (result.canceled || !result.filePath) return { canceled: true }
    try {
      await fsp.writeFile(result.filePath, content, 'utf-8')
      return { ok: true }
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) }
    }
  })

  ipcMain.handle(
    'transcribe:chunk',
    async (_e, id: string, chunk: ArrayBuffer, offsetSec: number) => {
      const { openaiApiKey, groqApiKey } = store.getSettings()
      const provider = openaiApiKey ? ('openai' as const) : ('groq' as const)
      const key = openaiApiKey || groqApiKey
      if (!key) return { error: 'missing-key' }
      try {
        const segments = await transcribeChunk(provider, key, Buffer.from(chunk), offsetSec)
        if (segments.length > 0) {
          store.appendTranscript(id, segments)
          notifySegments(id)
          notifyCloudSegments(id)
        }
        return { segments }
      } catch (err) {
        return { error: err instanceof Error ? err.message : String(err) }
      }
    }
  )

  ipcMain.handle('ai:ask', async (e, req: AskRequest) => {
    const { anthropicApiKey, groqApiKey } = store.getSettings()
    const send = (payload: unknown): void => {
      if (!e.sender.isDestroyed()) e.sender.send('ai:stream', payload)
    }
    if (!anthropicApiKey && !groqApiKey) {
      send({ requestId: req.requestId, type: 'error', error: 'missing-key' })
      return
    }
    try {
      const segments = store.getTranscript(req.sessionId)
      if (req.host) {
        // Host co-pilot: terse, audience-focused stage-manager persona.
        const meta = store.getMeta(req.sessionId)
        const status = conferenceStatus()
        const system = hostSystemPrompt(
          segments,
          meta?.agenda,
          {
            attendees: status.attendees ?? 0,
            recentAsks: status.recentAsks ?? 0,
            questions: (status.questions ?? []).map((g) => ({
              topic: g.topic,
              count: g.items.length
            }))
          },
          store.getMaterialsText(meta?.eventId),
          meta?.eventId ? practiceContext(meta.eventId) : null
        )
        await streamChatGeneric({
          keys: { anthropicApiKey, groqApiKey },
          system,
          history: req.history,
          question: req.question,
          onDelta: (text) => send({ requestId: req.requestId, type: 'delta', text })
        })
        send({ requestId: req.requestId, type: 'done' })
        return
      }
      const params = {
        apiKey: anthropicApiKey || groqApiKey,
        segments,
        history: req.history,
        question: req.question,
        live: req.live,
        frame: req.frame,
        priorContext: priorLearningContext(req.question, req.sessionId) ?? undefined,
        onDelta: (text: string) =>
          send({ requestId: req.requestId, type: 'delta', text })
      }
      // Claude is preferred when its key exists; Groq is the free-tier fallback.
      await (anthropicApiKey ? streamAsk(params) : streamAskGroq(params))
      send({ requestId: req.requestId, type: 'done' })
    } catch (err) {
      send({
        requestId: req.requestId,
        type: 'error',
        error: err instanceof Error ? err.message : String(err)
      })
    }
  })
}

async function runAnalysis(id: string): Promise<void> {
  try {
    const { anthropicApiKey, groqApiKey } = store.getSettings()
    if (!anthropicApiKey && !groqApiKey) return
    const segments = store.getTranscript(id)
    const kind = store.getMeta(id)?.kind ?? 'other'
    const result = anthropicApiKey
      ? await analyzeSession(anthropicApiKey, segments, kind)
      : await analyzeSessionGroq(groqApiKey, segments, kind)
    if (!result) return
    const meta = store.getMeta(id)
    if (!meta) return
    meta.title = result.title
    meta.summary = result.summary
    meta.highlights = result.highlights
    meta.analyzed = true
    store.saveMeta(meta)
    mainWindow?.webContents.send('session:updated', meta)
    // Memory: decisions, promises, people and concepts, pinned to their moments.
    await rememberSession({ anthropicApiKey, groqApiKey }, meta, segments).catch(() => undefined)
  } catch {
    // analysis is best-effort; the session itself is already saved
  }
}
