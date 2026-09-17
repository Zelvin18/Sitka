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
import JoinView from './components/JoinView'
import { applyAppearance } from './lib/prefs'
import { isThisTab, useLive } from './lib/live'

const PHONE_QUERY = '(max-width: 859px)'
const drawerWidth = (): number => Math.min(330, Math.round(window.innerWidth * 0.88))
import { readSession, usePersistedBool, writeSession } from './lib/persist'
import Home from './components/Home'
import EcosystemView from './components/EcosystemView'
import SettingsView from './components/SettingsView'
import LiveSession from './components/LiveSession'
import SessionView from './components/SessionView'
import QuickRecord from './components/QuickRecord'
import CreateView from './components/CreateView'
import ProfileMenu from './components/ProfileMenu'
import NamePrompt from './components/NamePrompt'
import Welcome from './components/Welcome'

type View =
  | { name: 'homepage' }
  | { name: 'home' }
  | { name: 'events'; eventId?: string }
  | { name: 'coach' }
  | { name: 'create' }
  | { name: 'join' }
  | { name: 'settings' }
  | { name: 'business' }
  | { name: 'education' }
  | { name: 'org'; id: string; spaceId?: string }
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

const VIEW_KEY = 'sitka.view'

/** The page to come back to after a refresh. A live session cannot survive a
 *  reload, so its page reopens on the setup screen; a replay forgets its seek. */
function restoreView(saved: View | undefined): View {
  if (!saved || typeof saved !== 'object' || typeof saved.name !== 'string') {
    return { name: 'homepage' }
  }
  if (saved.name === 'live') return { ...saved, quick: undefined }
  if (saved.name === 'session') return { name: 'session', id: saved.id }
  return saved
}

export default function App(): React.JSX.Element {
  // A refresh brings the user back to the page they were on, with the same
  // way back behind it. The memory lives with the tab, never in the account.
  const remembered = useRef(readSession<{ view: View; history: View[] }>(VIEW_KEY))
  const [view, setViewRaw] = useState<View>(() => restoreView(remembered.current?.view))
  // ---- navigation history: every page gets a real "back" ----
  const savedHistory = remembered.current?.history
  const historyRef = useRef<View[]>(Array.isArray(savedHistory) ? savedHistory : [])
  const viewRef = useRef<View>(view)
  const [canBack, setCanBack] = useState(historyRef.current.length > 0)
  const rememberView = (): void =>
    writeSession(VIEW_KEY, { view: viewRef.current, history: historyRef.current.slice(-12) })
  // Each page remembers which ecosystem it was visited in, so Back restores
  // the menu along with the page: a page opened under "you" comes back as
  // "you", even after a detour through Business.
  const spaceRef = useRef<Space | undefined>(undefined)
  const spaceHistoryRef = useRef<(Space | undefined)[]>([])
  /** the same page again — a session jumped to another moment, a page re-set to itself — is not a step in the history */
  const samePage = (a: View, b: View): boolean => {
    if (a.name !== b.name) return false
    if (a.name === 'session' && b.name === 'session') return a.id === b.id
    if (a.name === 'org' && b.name === 'org') return a.id === b.id && a.spaceId === b.spaceId
    return JSON.stringify(a) === JSON.stringify(b)
  }
  const setView = useCallback((next: View | ((v: View) => View)): void => {
    const resolved = typeof next === 'function' ? next(viewRef.current) : next
    if (!samePage(resolved, viewRef.current)) {
      historyRef.current = [...historyRef.current.slice(-40), viewRef.current]
      spaceHistoryRef.current = [...spaceHistoryRef.current.slice(-40), spaceRef.current]
      setCanBack(true)
    }
    viewRef.current = resolved
    setViewRaw(resolved)
    rememberView()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  /** the page in place of this one, with no step added: a recording that became its session */
  const replaceView = useCallback((next: View): void => {
    viewRef.current = next
    setViewRaw(next)
    rememberView()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  // A page with nothing to show (a session that is gone) asks for the library.
  useEffect(() => {
    const home = (): void => setView({ name: 'home' })
    window.addEventListener('sitka:home', home)
    return () => window.removeEventListener('sitka:home', home)
  }, [setView])
  const goBack = useCallback((): void => {
    const prev = historyRef.current.pop()
    if (!prev) return
    setSpace(spaceHistoryRef.current.pop())
    viewRef.current = prev
    setViewRaw(prev)
    setCanBack(historyRef.current.length > 0)
    rememberView()
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
  // The menu says where the person is, not where they last chose to go: back
  // out of Business to the home page and it reads "you" again; open an
  // organisation and it reads that organisation's kind.
  useEffect(() => {
    if (view.name === 'homepage') setSpace(undefined)
    else if (view.name === 'business') setSpace('business')
    else if (view.name === 'education') setSpace('education')
    else if (view.name === 'org') {
      const org = orgs.find((o) => o.id === view.id)
      if (org) setSpace(org.kind)
    } else if (view.name === 'live' && 'space' in view) setSpace(view.space)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view])
  useEffect(() => {
    spaceRef.current = space
    try {
      if (space) localStorage.setItem('sitka.space', space)
      else localStorage.removeItem('sitka.space')
    } catch {
      /* ignore */
    }
  }, [space])
  const [sessions, setSessions] = useState<SessionMeta[]>([])
  const [sessionsLoaded, setSessionsLoaded] = useState(false)
  // A new account is welcomed once, by name, when its library is still empty.
  const [welcome, setWelcome] = useState<string | null>(null)
  const welcomeChecked = useRef(false)
  // Its picture is fetched the moment the app opens for an account still to be
  // welcomed, so the card arrives with the picture already in hand.
  useEffect(() => {
    void window.sitka
      .getProfile()
      .then((p) => {
        if (p.needsWelcome) new Image().src = '/welcome-hero.png'
      })
      .catch(() => undefined)
  }, [])
  useEffect(() => {
    if (!sessionsLoaded || welcomeChecked.current) return
    welcomeChecked.current = true
    if (sessions.some((s) => !s.sample)) return
    void window.sitka
      .getProfile()
      .then((p) => {
        if (p.needsWelcome) setWelcome(p.name)
      })
      .catch(() => undefined)
  }, [sessionsLoaded, sessions])
  // "Keep in my library" on a shared recap sends the person here with the
  // recap's id in the address: it is kept, the library refreshed, the recap opened.
  const keepChecked = useRef(false)
  useEffect(() => {
    if (!sessionsLoaded || keepChecked.current) return
    const m = /^#keep=([\w-]+)/.exec(location.hash)
    if (!m) return
    keepChecked.current = true
    const id = m[1]
    history.replaceState(null, '', location.pathname)
    void window.sitka
      .keepRecap(id)
      .then(async (r) => {
        if (r.error) {
          window.alert(r.error)
          return
        }
        await refreshSessions()
        openSession(id)
      })
      .catch(() => undefined)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionsLoaded])
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
    let inSidebar = false
    const clamp = (v: number): number => Math.max(0, Math.min(drawerWidth(), v))
    const onStart = (e: TouchEvent): void => {
      if (!isPhone() || e.touches.length !== 1) return
      const t = e.target as HTMLElement
      // a sideways drag inside a scrolling row or a text field belongs to it
      if (t.closest('.seg, .tab-row, .filmstrip, input, textarea, .tour-stage, .dialog-overlay')) return
      sx = e.touches[0].clientX
      sy = e.touches[0].clientY
      base = sidebarOpenRef.current ? drawerWidth() : 0
      inSidebar = Boolean(t.closest('.sidebar'))
      active = true
      horizontal = false
    }
    const onMove = (e: TouchEvent): void => {
      if (!active) return
      const dx = e.touches[0].clientX - sx
      const dy = e.touches[0].clientY - sy
      if (!horizontal) {
        // A finger that wobbles a little while tapping is a tap, not a drag:
        // the gesture begins only once it has clearly gone sideways. In the
        // sidebar itself only a swipe back to the left is a drawer gesture —
        // its rows are there to be tapped.
        const threshold = inSidebar ? 28 : 14
        if (Math.abs(dx) < threshold && Math.abs(dy) < 10) return
        if (Math.abs(dy) > Math.abs(dx)) {
          active = false // a scroll, not a drawer gesture
          return
        }
        if (Math.abs(dx) < threshold) return
        if (inSidebar && dx > 0) {
          active = false // a sideways wobble to the right inside the sidebar is still a tap
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

  // Quick record: one tap (or Ctrl+Shift+R) opens a new session with Audio
  // already chosen, filed under whichever ecosystem the user is standing in.
  // It stops at the setup page — recording begins only when they press Start,
  // so nothing is captured before they have chosen what they want.
  // The live session, in this tab or another: shown everywhere, and it stops
  // a second one from starting.
  const liveBeat = useLive()
  const liveHere = Boolean(recordingSessionId) || (liveBeat !== null && isThisTab(liveBeat))
  const liveElsewhere = liveBeat !== null && !isThisTab(liveBeat) && !recordingSessionId

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
      quick: false
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

  const [sessionsError, setSessionsError] = useState('')
  const refreshSessions = useCallback(async (): Promise<void> => {
    // The library must never spin for good: a list that stalls or fails is
    // said out loud, with a way to ask again.
    try {
      const list = await Promise.race([
        window.sitka.listSessions(),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timeout')), 20000))
      ])
      setSessions(list)
      setSessionsError('')
    } catch (err) {
      setSessionsError(err instanceof Error && err.message === 'timeout' ? 'slow' : 'failed')
    } finally {
      setSessionsLoaded(true)
    }
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
  // The sidebar: every hosted event on top, wherever it was filed, and then
  // the sessions of the ecosystem the person is in. A plain Business or
  // Education session stays in the library until they step into that space.
  const sidebarSessions = sessions.filter((s) => s.hosted || inSpace(s))

  return (
    <div className="app">
      {welcome ? (
        <Welcome
          name={welcome}
          onClose={() => {
            setWelcome(null)
            void window.sitka.markWelcomed().catch(() => undefined)
          }}
        />
      ) : (
        <NamePrompt />
      )}
      {(sidebarOpen || phone) && (
        <Sidebar
          sessions={sidebarSessions}
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
          onJoin={() => {
            setView({ name: 'join' })
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
        {/* "Sitca for" at the top right: personal, Education or Business. */}
        <div className="top-right">
        {(liveHere || liveElsewhere) && view.name !== 'live' && (
          <button
            type="button"
            className="live-pill"
            title={
              liveElsewhere
                ? `"${liveBeat?.title ?? 'A session'}" is recording in another tab. End it there before starting another.`
                : 'Back to the live session'
            }
            onClick={() => {
              if (liveHere) setView({ name: 'live' })
            }}
          >
            <i />
            LIVE
            <small>{liveElsewhere ? 'in another tab' : liveBeat?.title ?? 'recording'}</small>
          </button>
        )}
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
            allSessions={sessions}
            onNewSession={() => setView({ name: 'live' })}
            onGoEvents={() => setView({ name: 'events' })}
            onGoOverview={() => setView({ name: 'brain' })}
            onGoLibrary={() => setView({ name: 'home' })}
            onOpenSession={openSession}
            onNewAudioSession={() => setView({ name: 'live', audioOnly: true })}
            onJoin={() => setView({ name: 'join' })}
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
            onDeleteSession={(id) => void deleteSession(id)}
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
                onDeleteSession={(id) => deleteSession(id)}
                onOpenSettings={() => setView({ name: 'settings' })}
                onLeft={() => {
                  void refreshOrgs()
                  setView(org.kind === 'business' ? { name: 'business' } : { name: 'education' })
                }}
                onChanged={() => {
                  void refreshOrgs()
                  void refreshSessions()
                }}
                spaceId={view.name === 'org' ? view.spaceId : undefined}
                onSpace={(spaceId) => setView({ name: 'org', id: org.id, spaceId: spaceId ?? undefined })}
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
        {view.name === 'join' && <JoinView onBack={goBack} />}
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
            loaded={sessionsLoaded}
            loadError={sessionsError}
            onRetry={() => {
              setSessionsLoaded(false)
              void refreshSessions()
            }}
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
                // the session takes the recorder's place: Back goes to where the recording was started from
                replaceView({ name: 'session', id })
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
