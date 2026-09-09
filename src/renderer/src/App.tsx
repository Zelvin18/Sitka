import React, { useCallback, useEffect, useRef, useState } from 'react'
import type { Organization, SessionKind, SessionMeta, Settings, Space } from '@shared/types'
import OrgView from './components/OrgView'
import Sidebar from './components/Sidebar'
import BrainView from './components/BrainView'
import HomeView from './components/HomeView'
import EventsView from './components/EventsView'
import CoachView from './components/CoachView'
import CommandPalette from './components/CommandPalette'
import { IconMenu } from './lib/icons'
import SpaceMenu from './components/SpaceMenu'
import { applyAppearance } from './lib/prefs'

const PHONE_QUERY = '(max-width: 859px)'
const drawerWidth = (): number => Math.min(330, Math.round(window.innerWidth * 0.88))
import { usePersistedBool } from './lib/persist'
import Home from './components/Home'
import EcosystemView from './components/EcosystemView'
import SettingsView from './components/SettingsView'
import LiveSession from './components/LiveSession'
import SessionView from './components/SessionView'
import QuickRecord from './components/QuickRecord'
import CreateView from './components/CreateView'
import ProfileMenu from './components/ProfileMenu'

type View =
  | { name: 'homepage' }
  | { name: 'home' }
  | { name: 'events'; eventId?: string }
  | { name: 'coach' }
  | { name: 'create' }
  | { name: 'settings' }
  | { name: 'business' }
  | { name: 'education' }
  | { name: 'org'; id: string }
  | {
      name: 'live'
      eventId?: string
      space?: Space
      presetKind?: SessionKind
      audioOnly?: boolean
      /** quick record: start the audio session immediately */
      quick?: boolean
      /** file the session into an organisation space */
      orgSpaceId?: string
      orgSpaceName?: string
    }
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
  const [recordingStartedAt, setRecordingStartedAt] = useState<number | undefined>()
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

  // Phone: the page is a drawer. The sidebar waits underneath on the left;
  // dragging the page to the right slides it open and follows the finger,
  // dragging it back closes it, with a small tick of haptic feedback.
  const [phone, setPhone] = useState(() => window.matchMedia(PHONE_QUERY).matches)
  useEffect(() => {
    const mq = window.matchMedia(PHONE_QUERY)
    const on = (): void => setPhone(mq.matches)
    mq.addEventListener('change', on)
    return () => mq.removeEventListener('change', on)
  }, [])
  const [dragX, setDragX] = useState<number | null>(null)
  const sidebarOpenRef = useRef(sidebarOpen)
  sidebarOpenRef.current = sidebarOpen
  useEffect(() => {
    let sx = 0
    let sy = 0
    let base = 0
    let active = false
    let horizontal = false
    const clamp = (v: number): number => Math.max(0, Math.min(drawerWidth(), v))
    const onStart = (e: TouchEvent): void => {
      if (!isPhone() || e.touches.length !== 1) return
      const t = e.target as HTMLElement
      // a sideways drag inside a scrolling row or a text field belongs to it
      if (t.closest('.seg, .tab-row, .filmstrip, input, textarea, .tour-stage, .dialog-overlay')) return
      sx = e.touches[0].clientX
      sy = e.touches[0].clientY
      base = sidebarOpenRef.current ? drawerWidth() : 0
      active = true
      horizontal = false
    }
    const onMove = (e: TouchEvent): void => {
      if (!active) return
      const dx = e.touches[0].clientX - sx
      const dy = e.touches[0].clientY - sy
      if (!horizontal) {
        if (Math.abs(dx) < 10 && Math.abs(dy) < 10) return
        if (Math.abs(dy) > Math.abs(dx)) {
          active = false // a scroll, not a drawer gesture
          return
        }
        horizontal = true
      }
      e.preventDefault()
      setDragX(clamp(base + dx))
    }
    const onEnd = (e: TouchEvent): void => {
      if (!active) return
      active = false
      if (!horizontal) return
      const dx = e.changedTouches[0].clientX - sx
      const w = drawerWidth()
      // a decisive flick wins; otherwise wherever the page came to rest
      const open = Math.abs(dx) > 90 ? dx > 0 : clamp(base + dx) > w / 2
      setDragX(null)
      if (open !== sidebarOpenRef.current) {
        setSidebarOpen(open)
        try {
          navigator.vibrate?.(open ? 12 : 8)
        } catch {
          /* not every phone can */
        }
      }
    }
    document.addEventListener('touchstart', onStart, { passive: true })
    document.addEventListener('touchmove', onMove, { passive: false })
    document.addEventListener('touchend', onEnd, { passive: true })
    document.addEventListener('touchcancel', onEnd, { passive: true })
    return () => {
      document.removeEventListener('touchstart', onStart)
      document.removeEventListener('touchmove', onMove)
      document.removeEventListener('touchend', onEnd)
      document.removeEventListener('touchcancel', onEnd)
    }
  }, [setSidebarOpen])
  const mainX = phone ? (dragX ?? (sidebarOpen ? drawerWidth() : 0)) : 0
  const mainStyle: React.CSSProperties | undefined = phone
    ? {
        transform: mainX ? `translateX(${mainX}px)` : undefined,
        transition: dragX === null ? 'transform 0.28s cubic-bezier(0.2, 0.8, 0.2, 1)' : 'none'
      }
    : undefined

  // Appearance follows the saved preferences.
  useEffect(() => {
    if (settings) applyAppearance(settings.theme, settings.textSize)
  }, [settings])

  // Quick record: one tap (or Ctrl+Shift+R) starts an audio session right now,
  // filed under whichever ecosystem the user is standing in.
  const quickRecord = useCallback((): void => {
    if (recordingSessionId) {
      setView({ name: 'live' })
      return
    }
    setView({
      name: 'live',
      space,
      presetKind: space === 'business' ? 'meeting' : space === 'education' ? 'lecture' : 'other',
      audioOnly: true,
      quick: true
    })
    closeDrawer()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recordingSessionId, space, closeDrawer])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        setPaletteOpen((v) => !v)
      }
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === 'r') {
        e.preventDefault()
        quickRecord()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [quickRecord])

  const refreshSessions = useCallback(async (): Promise<void> => {
    setSessions(await window.sitka.listSessions())
  }, [])

  // Organisations: a university or a company the user belongs to.
  const [orgs, setOrgs] = useState<Organization[]>([])
  const refreshOrgs = useCallback(async (): Promise<void> => {
    setOrgs(await window.sitka.listOrgs())
  }, [])
  useEffect(() => {
    void refreshOrgs()
  }, [refreshOrgs])

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
      {(sidebarOpen || phone) && (
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
          onCreate={() => {
            setView({ name: 'create' })
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
      <div className={`main${mainX ? ' shifted' : ''}`} style={mainStyle}>
        {/* Phone: while the page is slid aside, a tap on it closes the drawer. */}
        {phone && mainX > 0 && (
          <div
            className="drawer-backdrop"
            style={{ opacity: Math.min(1, mainX / drawerWidth()) }}
            onClick={() => setSidebarOpen(false)}
          />
        )}
        {/* A solid strip along the top: Back on the left, the doors on the right.
            Content scrolls beneath it, never through it. */}
        <div className="main-bar" />
        <div className="main-drag" />
        {!sidebarOpen && (
          <button
            className="sidebar-reopen"
            title="Show sidebar"
            aria-label="Show sidebar"
            onClick={() => setSidebarOpen(true)}
          >
            <IconMenu size={22} strokeWidth={2} />
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
        {/* "Sitka for" at the top right: personal, Education or Business. */}
        <div className="top-right">
        <SpaceMenu
          space={space}
          onPick={(s) => {
            setSpace(s)
            setView(
              s === 'business'
                ? { name: 'business' }
                : s === 'education'
                  ? { name: 'education' }
                  : { name: 'homepage' }
            )
            closeDrawer()
          }}
        />
        <ProfileMenu
          sessions={sessions}
          onSettings={() => setView({ name: 'settings' })}
          onLibrary={() => setView({ name: 'home' })}
          onOverview={() => setView({ name: 'brain' })}
        />
        </div>
        {view.name === 'homepage' && (
          <HomeView
            sessions={sessions.filter((s) => !s.space)}
            onNewSession={() => setView({ name: 'live' })}
            onGoEvents={() => setView({ name: 'events' })}
            onGoOverview={() => setView({ name: 'brain' })}
            onGoLibrary={() => setView({ name: 'home' })}
            onOpenSession={openSession}
            onNewAudioSession={() => setView({ name: 'live', audioOnly: true })}
          />
        )}
        {(view.name === 'business' || view.name === 'education') && (
          <EcosystemView
            kind={view.name}
            sessions={sessions.filter((s) => s.space === view.name)}
            onStartSession={(presetKind, audioOnly) =>
              setView({ name: 'live', space: view.name, presetKind, audioOnly })
            }
            onGoEvents={() => setView({ name: 'events' })}
            onGoCoach={() => setView({ name: 'coach' })}
            onGoOverview={() => setView({ name: 'brain' })}
            onOpenSession={openSession}
            orgs={orgs.filter((o) => o.kind === view.name)}
            onJoinedOrg={(org) => {
              void refreshOrgs()
              setView({ name: 'org', id: org.id })
            }}
            onOpenOrg={(org) => setView({ name: 'org', id: org.id })}
          />
        )}
        {view.name === 'org' &&
          (() => {
            const org = orgs.find((o) => o.id === (view as { id: string }).id)
            if (!org) return null
            return (
              <OrgView
                key={org.id}
                org={org}
                mySessions={sessions.filter((s) => s.space === org.kind || s.spaceId)}
                hasChatKey={Boolean(settings?.anthropicApiKey || settings?.groqApiKey)}
                onStartSession={(presetKind, audioOnly, orgSpaceId, orgSpaceName) => {
                  setSpace(org.kind)
                  setView({ name: 'live', space: org.kind, presetKind, audioOnly, orgSpaceId, orgSpaceName })
                }}
                onOpenSession={openSession}
                onOpenSettings={() => setView({ name: 'settings' })}
                onLeft={() => {
                  void refreshOrgs()
                  setView(org.kind === 'business' ? { name: 'business' } : { name: 'education' })
                }}
                onChanged={() => {
                  void refreshOrgs()
                  void refreshSessions()
                }}
              />
            )
          })()}
        {view.name === 'coach' && (
          <CoachView
            hasChatKey={Boolean(settings?.anthropicApiKey || settings?.groqApiKey)}
            hasSttKey={Boolean(settings?.openaiApiKey || settings?.groqApiKey)}
            onOpenSettings={() => setView({ name: 'settings' })}
          />
        )}
        {view.name === 'create' && (
          <CreateView
            sessions={sessions}
            hasChatKey={Boolean(settings?.anthropicApiKey || settings?.groqApiKey)}
            onOpenSettings={() => setView({ name: 'settings' })}
            onOpenSessionAt={openSession}
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
          <SettingsView settings={settings} onSaved={setSettings} onOpenSession={(id) => openSession(id)} />
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
              presetAudio={view.name === 'live' ? view.audioOnly : undefined}
              autoStart={view.name === 'live' ? view.quick : undefined}
              orgSpaceId={view.name === 'live' ? view.orgSpaceId : undefined}
              orgSpaceName={view.name === 'live' ? view.orgSpaceName : undefined}
              defaultCapture={settings?.defaultCapture}
              notesOn={settings?.notes !== false}
              readScreen={settings?.readScreen !== false}
              onGoEvents={(eventId) => setView({ name: 'events', eventId })}
              onSessionCreated={(meta) => {
                setRecordingSessionId(meta.id)
                setRecordingStartedAt(Date.now())
                void refreshSessions()
              }}
              onFinished={(id) => {
                setRecordingSessionId(undefined)
                setRecordingStartedAt(undefined)
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
      <QuickRecord
        recording={recordingSessionId !== undefined}
        startedAt={recordingStartedAt}
        hidden={view.name === 'live'}
        onStart={quickRecord}
        onOpen={() => setView({ name: 'live' })}
      />
    </div>
  )
}
