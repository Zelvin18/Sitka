import React, { useCallback, useEffect, useRef, useState } from 'react'
import type { SessionKind, SessionMeta, Settings, Space } from '@shared/types'
import Sidebar from './components/Sidebar'
import BrainView from './components/BrainView'
import HomeView from './components/HomeView'
import EventsView from './components/EventsView'
import CoachView from './components/CoachView'
import CommandPalette from './components/CommandPalette'
import { IconPanel } from './lib/icons'
import { usePersistedBool } from './lib/persist'
import Home from './components/Home'
import EcosystemView from './components/EcosystemView'
import SettingsView from './components/SettingsView'
import LiveSession from './components/LiveSession'
import SessionView from './components/SessionView'

type View =
  | { name: 'homepage' }
  | { name: 'home' }
  | { name: 'events'; eventId?: string }
  | { name: 'coach' }
  | { name: 'settings' }
  | { name: 'business' }
  | { name: 'education' }
  | { name: 'live'; eventId?: string; space?: Space; presetKind?: SessionKind }
  | { name: 'brain' }
  | { name: 'session'; id: string; seekTo?: number; seekNonce?: number }

export default function App(): React.JSX.Element {
  const [view, setViewRaw] = useState<View>({ name: 'homepage' })
  // ---- navigation history: every page gets a real "back" ----
  const historyRef = useRef<View[]>([])
  const viewRef = useRef<View>({ name: 'homepage' })
  const [canBack, setCanBack] = useState(false)
  const setView = useCallback((next: View | ((v: View) => View)): void => {
    const resolved = typeof next === 'function' ? next(viewRef.current) : next
    if (resolved.name !== viewRef.current.name || JSON.stringify(resolved) !== JSON.stringify(viewRef.current)) {
      historyRef.current = [...historyRef.current.slice(-40), viewRef.current]
      setCanBack(true)
    }
    viewRef.current = resolved
    setViewRaw(resolved)
  }, [])
  const goBack = useCallback((): void => {
    const prev = historyRef.current.pop()
    if (!prev) return
    viewRef.current = prev
    setViewRaw(prev)
    setCanBack(historyRef.current.length > 0)
  }, [])

  // ---- which ecosystem the user is inside (general by default) ----
  const [space, setSpace] = useState<Space | undefined>(() => {
    try {
      const s = localStorage.getItem('sitka.space')
      return s === 'business' || s === 'education' ? s : undefined
    } catch {
      return undefined
    }
  })
  useEffect(() => {
    try {
      if (space) localStorage.setItem('sitka.space', space)
      else localStorage.removeItem('sitka.space')
    } catch {
      /* ignore */
    }
  }, [space])
  const [sessions, setSessions] = useState<SessionMeta[]>([])
  const [settings, setSettings] = useState<Settings | null>(null)
  const [recordingSessionId, setRecordingSessionId] = useState<string | undefined>()
  const [refreshToken, setRefreshToken] = useState(0)
  const [sidebarOpen, setSidebarOpen] = usePersistedBool(
    'sitka.sidebar',
    window.innerWidth >= 860
  )
  const [paletteOpen, setPaletteOpen] = useState(false)

  // On phone-sized screens the sidebar is an overlay drawer: start closed,
  // and slide away once a destination is chosen.
  const isPhone = (): boolean => window.innerWidth < 860
  useEffect(() => {
    if (isPhone()) setSidebarOpen(false)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  const closeDrawer = useCallback((): void => {
    if (isPhone()) setSidebarOpen(false)
  }, [setSidebarOpen])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        setPaletteOpen((v) => !v)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const refreshSessions = useCallback(async (): Promise<void> => {
    setSessions(await window.sitka.listSessions())
  }, [])

  useEffect(() => {
    void refreshSessions()
    void window.sitka.getSettings().then(setSettings)
    const off = window.sitka.onSessionUpdated(() => {
      void refreshSessions()
      setRefreshToken((t) => t + 1)
    })
    return off
  }, [refreshSessions])

  const openSession = useCallback(
    (id: string, seekTo?: number) => {
      if (recordingSessionId === id) {
        setView({ name: 'live' })
      } else {
        setView({ name: 'session', id, seekTo, seekNonce: Date.now() })
      }
      closeDrawer()
    },
    [recordingSessionId, closeDrawer]
  )

  const deleteSession = useCallback(
    async (id: string): Promise<void> => {
      if (id === recordingSessionId) return
      await window.sitka.deleteSession(id)
      setView((v) => (v.name === 'session' && v.id === id ? { name: 'home' } : v))
      await refreshSessions()
    },
    [recordingSessionId, refreshSessions]
  )

  const renameSession = useCallback(
    async (id: string, title: string): Promise<void> => {
      await window.sitka.renameSession(id, title)
      await refreshSessions()
      setRefreshToken((t) => t + 1)
    },
    [refreshSessions]
  )

  const activeSessionId =
    view.name === 'session' ? view.id : view.name === 'live' ? recordingSessionId : undefined

  // Sessions are scoped: general shows only general ones, an ecosystem only its own.
  const inSpace = (s: SessionMeta): boolean => (space ? s.space === space : !s.space)
  const scopedSessions = sessions.filter(inSpace)

  return (
    <div className="app">
      {sidebarOpen && (
        <Sidebar
          sessions={scopedSessions}
          activeView={view.name}
          activeSessionId={activeSessionId}
          recordingSessionId={recordingSessionId}
          onHomePage={() => {
            setSpace(undefined)
            setView({ name: 'homepage' })
            closeDrawer()
          }}
          onEvents={() => {
            setView({ name: 'events' })
            closeDrawer()
          }}
          onCoach={() => {
            setView({ name: 'coach' })
            closeDrawer()
          }}
          onHome={() => {
            setView({ name: 'home' })
            closeDrawer()
          }}
          onNewSession={() => {
            setView(
              space
                ? { name: 'live', space, presetKind: space === 'business' ? 'meeting' : 'lecture' }
                : { name: 'live' }
            )
            closeDrawer()
          }}
          onBrain={() => {
            setView({ name: 'brain' })
            closeDrawer()
          }}
          onOpenSession={openSession}
          onSettings={() => {
            setView({ name: 'settings' })
            closeDrawer()
          }}
          onCollapse={() => setSidebarOpen(false)}
          onRenameSession={(id, title) => void renameSession(id, title)}
          onDeleteSession={(id) => void deleteSession(id)}
        />
      )}
      <div className="main">
        <div className="main-drag" />
        {!sidebarOpen && (
          <button
            className="btn btn-ghost btn-sm sidebar-reopen"
            title="Show sidebar"
            onClick={() => setSidebarOpen(true)}
          >
            <IconPanel size={14} />
          </button>
        )}
        {canBack && view.name !== 'homepage' && (
          <button
            className={`btn btn-ghost btn-sm global-back${sidebarOpen ? '' : ' shifted'}`}
            title="Back to the previous page"
            onClick={goBack}
          >
            ‹ Back
          </button>
        )}
        {space && view.name !== 'homepage' && (
          <span className={`space-tag${sidebarOpen ? '' : ' shifted'}`}>
            {space === 'business' ? 'Business' : 'Education'}
          </span>
        )}
        {view.name === 'homepage' && (
          <HomeView
            sessions={sessions.filter((s) => !s.space)}
            onNewSession={() => setView({ name: 'live' })}
            onGoEvents={() => setView({ name: 'events' })}
            onGoOverview={() => setView({ name: 'brain' })}
            onGoLibrary={() => setView({ name: 'home' })}
            onOpenSession={openSession}
            onGoBusiness={() => {
              setSpace('business')
              setView({ name: 'business' })
            }}
            onGoEducation={() => {
              setSpace('education')
              setView({ name: 'education' })
            }}
          />
        )}
        {(view.name === 'business' || view.name === 'education') && (
          <EcosystemView
            kind={view.name}
            sessions={sessions.filter((s) => s.space === view.name)}
            onStartSession={(presetKind) =>
              setView({ name: 'live', space: view.name, presetKind })
            }
            onGoEvents={() => setView({ name: 'events' })}
            onGoCoach={() => setView({ name: 'coach' })}
            onGoOverview={() => setView({ name: 'brain' })}
            onOpenSession={openSession}
          />
        )}
        {view.name === 'coach' && (
          <CoachView
            hasChatKey={Boolean(settings?.anthropicApiKey || settings?.groqApiKey)}
            hasSttKey={Boolean(settings?.openaiApiKey || settings?.groqApiKey)}
            onOpenSettings={() => setView({ name: 'settings' })}
          />
        )}
        {view.name === 'events' && (
          <EventsView
            initialEventId={view.eventId}
            onStartEvent={(eventId) => setView({ name: 'live', eventId })}
            onOpenSession={openSession}
          />
        )}
        {view.name === 'home' && (
          <Home
            sessions={sessions}
            settings={settings}
            onNewSession={() => setView({ name: 'live' })}
            onOpenSession={openSession}
            onDeleteSession={(id) => void deleteSession(id)}
            onSettings={() => setView({ name: 'settings' })}
          />
        )}
        {view.name === 'settings' && (
          <SettingsView settings={settings} onSaved={setSettings} />
        )}
        {view.name === 'brain' && (
          <BrainView
            sessions={sessions}
            hasChatKey={Boolean(settings?.anthropicApiKey || settings?.groqApiKey)}
            onOpenSettings={() => setView({ name: 'settings' })}
            onOpenSessionAt={openSession}
          />
        )}
        {(view.name === 'live' || recordingSessionId !== undefined) && (
          <div
            style={{
              display: view.name === 'live' ? 'flex' : 'none',
              flexDirection: 'column',
              flex: 1,
              minHeight: 0
            }}
          >
            <LiveSession
              hasChatKey={Boolean(settings?.anthropicApiKey || settings?.groqApiKey)}
              hasSttKey={Boolean(settings?.openaiApiKey || settings?.groqApiKey)}
              sessions={sessions}
              onOpenSessionAt={openSession}
              initialEventId={view.name === 'live' ? view.eventId : undefined}
              space={view.name === 'live' ? view.space : undefined}
              presetKind={view.name === 'live' ? view.presetKind : undefined}
              onGoEvents={(eventId) => setView({ name: 'events', eventId })}
              onSessionCreated={(meta) => {
                setRecordingSessionId(meta.id)
                void refreshSessions()
              }}
              onFinished={(id) => {
                setRecordingSessionId(undefined)
                void refreshSessions()
                setView({ name: 'session', id })
              }}
              onCancel={goBack}
              onOpenSettings={() => setView({ name: 'settings' })}
            />
          </div>
        )}
        {view.name === 'session' && (
          <SessionView
            key={view.id}
            sessionId={view.id}
            hasChatKey={Boolean(settings?.anthropicApiKey || settings?.groqApiKey)}
            sessions={sessions}
            onOpenSessionAt={openSession}
            onOpenSettings={() => setView({ name: 'settings' })}
            refreshToken={refreshToken}
            initialSeek={view.seekTo}
            seekNonce={view.seekNonce}
          />
        )}
      </div>
      {paletteOpen && (
        <CommandPalette
          sessions={sessions}
          onClose={() => setPaletteOpen(false)}
          onAction={(action) => {
            if (action === 'new') setView({ name: 'live' })
            else if (action === 'brain') setView({ name: 'brain' })
            else if (action === 'home') setView({ name: 'home' })
            else setView({ name: 'settings' })
          }}
          onOpenSessionAt={openSession}
        />
      )}
    </div>
  )
}
