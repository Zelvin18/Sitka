import React, { useCallback, useEffect, useMemo, useState } from 'react'
import type {
  OrgMember,
  OrgSpace,
  OrgSpaceKind,
  Organization,
  SessionKind,
  SessionMeta,
  SpaceInsight,
  SpaceMaterial
} from '@shared/types'
import { sizeLabel } from '@shared/materialsLogic'
import ChatPane from './ChatPane'
import ConfirmDialog from './ConfirmDialog'
import MaterialsPanel from './MaterialsPanel'
import { formatDate, formatDuration } from '../lib/format'
import {
  IconBriefcase,
  IconCap,
  IconCopy,
  IconDoc,
  IconFolder,
  IconMic,
  IconPlay,
  IconPlus,
  IconScreen,
  IconSparkle,
  IconTrash,
  Mark
} from '../lib/icons'

interface Props {
  org: Organization
  /** the user's own sessions of this ecosystem, offered for filing into a space */
  mySessions: SessionMeta[]
  hasChatKey: boolean
  onStartSession: (kind: SessionKind, audioOnly: boolean, spaceId: string, spaceName: string) => void
  onOpenSession: (id: string, seconds?: number) => void
  onOpenSettings: () => void
  onLeft: () => void
  onChanged: () => void
}

type Tab = 'ask' | 'sessions' | 'materials' | 'understanding' | 'people'

const spaceNoun = (kind: OrgSpaceKind): string =>
  kind === 'course' ? 'course' : kind === 'team' ? 'team' : 'project'

/**
 * An organisation's workspace: a university or a company, with its spaces.
 * A space holds people, materials, sessions and Sitka — nothing else.
 */
export default function OrgView({
  org,
  mySessions,
  hasChatKey,
  onStartSession,
  onOpenSession,
  onOpenSettings,
  onLeft,
  onChanged
}: Props): React.JSX.Element {
  const education = org.kind === 'education'
  const lead = org.role === 'owner' || org.role === 'lead'
  const [spaces, setSpaces] = useState<OrgSpace[]>([])
  const [members, setMembers] = useState<OrgMember[]>([])
  const [active, setActive] = useState<OrgSpace | null>(null)
  const [tab, setTab] = useState<Tab>('ask')
  const [creating, setCreating] = useState(false)
  const [newName, setNewName] = useState('')
  const [newDesc, setNewDesc] = useState('')
  const [newKind, setNewKind] = useState<OrgSpaceKind>(education ? 'course' : 'team')
  const [createError, setCreateError] = useState<string | null>(null)
  const [copied, setCopied] = useState<string | null>(null)
  const [confirmLeave, setConfirmLeave] = useState(false)
  const [confirmDeleteSpace, setConfirmDeleteSpace] = useState<OrgSpace | null>(null)

  // per-space data
  const [sessions, setSessions] = useState<SessionMeta[]>([])
  const [materials, setMaterials] = useState<SpaceMaterial[]>([])
  const [insights, setInsights] = useState<SpaceInsight[] | null>(null)
  const [chatKey, setChatKey] = useState(0)
  const [fileId, setFileId] = useState('')

  const refresh = useCallback(async (): Promise<void> => {
    const [s, m] = await Promise.all([window.sitka.listSpaces(org.id), window.sitka.listOrgMembers(org.id)])
    setSpaces(s)
    setMembers(m)
    setActive((a) => (a ? (s.find((x) => x.id === a.id) ?? null) : a))
  }, [org.id])
  useEffect(() => {
    void refresh()
  }, [refresh])

  const loadSpace = useCallback(async (space: OrgSpace): Promise<void> => {
    const [s, m] = await Promise.all([
      window.sitka.listSpaceSessions(space.id),
      window.sitka.listSpaceMaterials(space.id)
    ])
    setSessions(s)
    setMaterials(m)
    setInsights(null)
  }, [])
  useEffect(() => {
    if (active) void loadSpace(active)
  }, [active, loadSpace])

  useEffect(() => {
    if (tab === 'understanding' && active && lead && insights === null) {
      void window.sitka.spaceInsights(active.id).then(setInsights)
    }
  }, [tab, active, lead, insights])

  const copy = (text: string, what: string): void => {
    void navigator.clipboard.writeText(text)
    setCopied(what)
    setTimeout(() => setCopied(null), 1600)
  }

  const createSpace = async (): Promise<void> => {
    setCreateError(null)
    const res = await window.sitka.createSpace(org.id, newName, newKind, newDesc)
    if (res.error) {
      setCreateError(res.error)
      return
    }
    setCreating(false)
    setNewName('')
    setNewDesc('')
    await refresh()
    onChanged()
    if (res.space) {
      setActive(res.space)
      setTab(lead ? 'materials' : 'ask')
    }
  }

  const unfiled = useMemo(
    () => mySessions.filter((s) => s.status === 'complete' && !s.sample && s.spaceId !== active?.id),
    [mySessions, active]
  )

  const fileSession = async (): Promise<void> => {
    if (!active || !fileId) return
    await window.sitka.assignSessionToSpace(fileId, active.id)
    setFileId('')
    await loadSpace(active)
    await refresh()
    onChanged()
  }

  const kindIcon = (k: OrgSpaceKind): React.JSX.Element =>
    k === 'course' ? <IconCap size={16} strokeWidth={1.7} /> : k === 'team' ? <IconBriefcase size={16} strokeWidth={1.7} /> : <IconFolder size={16} strokeWidth={1.7} />

  // ---------------- organisation home ----------------
  if (!active) {
    return (
      <div className="content">
        <div className="content-inner" style={{ maxWidth: 940 }}>
          <div className="org-head">
            <span className="org-mark">{education ? <IconCap size={20} strokeWidth={1.6} /> : <IconBriefcase size={20} strokeWidth={1.6} />}</span>
            <div style={{ minWidth: 0, flex: 1 }}>
              <div className="eco-kicker">{education ? 'Sitka for Education' : 'Sitka for Business'}</div>
              <h1 className="page-title" style={{ marginBottom: 4 }}>
                {org.name}
              </h1>
              <div className="org-meta">
                <span>
                  {org.members} {org.members === 1 ? 'member' : 'members'}
                </span>
                <span className="org-meta-dot" />
                <span>
                  {spaces.length} {spaces.length === 1 ? spaceNoun(spaces[0].kind) : education ? 'courses' : 'spaces'}
                </span>
                <span className="org-meta-dot" />
                <span>{org.role === 'owner' ? 'You own this' : org.role === 'lead' ? (education ? 'Lecturer' : 'Lead') : education ? 'Student' : 'Member'}</span>
              </div>
            </div>
            {lead && org.code && (
              <div className="org-codes">
                <button className="org-code" onClick={() => copy(org.code!, 'code')} title="Copy the join code for students and members">
                  <span className="org-code-label">{education ? 'Students join with' : 'Members join with'}</span>
                  <span className="org-code-value">{copied === 'code' ? 'Copied' : org.code}</span>
                  <IconCopy size={12} />
                </button>
                {org.leadCode && (
                  <button className="org-code" onClick={() => copy(org.leadCode!, 'lead')} title="Copy the join code for lecturers and leads">
                    <span className="org-code-label">{education ? 'Lecturers join with' : 'Leads join with'}</span>
                    <span className="org-code-value">{copied === 'lead' ? 'Copied' : org.leadCode}</span>
                    <IconCopy size={12} />
                  </button>
                )}
              </div>
            )}
          </div>

          <div className="org-section-row">
            <div className="section-title" style={{ margin: 0 }}>
              {education ? 'Courses' : 'Spaces'}
            </div>
            {lead && (
              <button className="btn btn-sm" onClick={() => setCreating((v) => !v)}>
                <IconPlus size={13} strokeWidth={2.2} />
                {education ? 'New course' : 'New space'}
              </button>
            )}
          </div>

          {creating && (
            <div className="org-create">
              <div className="org-create-row">
                <input
                  className="input"
                  placeholder={education ? 'Course name, e.g. CS201 Software Security' : 'Name, e.g. Product team'}
                  value={newName}
                  autoFocus
                  onChange={(e) => setNewName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') void createSpace()
                  }}
                />
                {!education && (
                  <div className="seg">
                    {(['team', 'project'] as OrgSpaceKind[]).map((k) => (
                      <button key={k} className={`seg-btn${newKind === k ? ' on' : ''}`} onClick={() => setNewKind(k)}>
                        {k === 'team' ? 'Team' : 'Project'}
                      </button>
                    ))}
                  </div>
                )}
              </div>
              <input
                className="input"
                placeholder={education ? 'One line on what the course covers (optional)' : 'One line on what this space is for (optional)'}
                value={newDesc}
                onChange={(e) => setNewDesc(e.target.value)}
              />
              {createError && <div className="notice notice-error">{createError}</div>}
              <div style={{ display: 'flex', gap: 8 }}>
                <button className="btn btn-primary btn-sm" onClick={() => void createSpace()} disabled={!newName.trim()}>
                  Create
                </button>
                <button className="btn btn-ghost btn-sm" onClick={() => setCreating(false)}>
                  Cancel
                </button>
              </div>
            </div>
          )}

          {spaces.length === 0 ? (
            <div className="org-empty">
              {lead
                ? education
                  ? 'Create the first course. Upload its slides and readings, record the lectures, and every student in it gets a companion that knows exactly what was taught.'
                  : 'Create the first space. Add its materials, capture its meetings, and everyone in it gets a memory of what was decided and promised.'
                : education
                  ? 'No courses yet. Your lecturers will create them; they appear here the moment they do.'
                  : 'No spaces yet. Your leads will create them; they appear here the moment they do.'}
            </div>
          ) : (
            <div className="org-grid">
              {spaces.map((s) => (
                <button
                  key={s.id}
                  className="org-card"
                  onClick={() => {
                    setActive(s)
                    setTab('ask')
                    setChatKey((k) => k + 1)
                  }}
                >
                  <span className="org-card-icon">{kindIcon(s.kind)}</span>
                  <span className="org-card-name">{s.name}</span>
                  {s.description && <span className="org-card-desc">{s.description}</span>}
                  <span className="org-card-meta">
                    {s.sessions} {s.sessions === 1 ? 'session' : 'sessions'}
                    <span className="org-meta-dot" />
                    {s.materials} {s.materials === 1 ? 'document' : 'documents'}
                  </span>
                </button>
              ))}
            </div>
          )}

          <div className="section-title" style={{ marginTop: 36 }}>
            People
          </div>
          <div className="org-people">
            {members.map((m) => (
              <div key={m.userId} className="org-person">
                <span className="org-person-avatar">{(m.name || m.email || '?').slice(0, 1).toUpperCase()}</span>
                <span className="org-person-text">
                  <span className="org-person-name">{m.name}</span>
                  <span className="org-person-sub">{m.email}</span>
                </span>
                <span className="org-person-role">
                  {m.role === 'owner' ? 'Owner' : m.role === 'lead' ? (education ? 'Lecturer' : 'Lead') : education ? 'Student' : 'Member'}
                </span>
              </div>
            ))}
          </div>

          <div className="org-foot">
            <span>
              {education
                ? 'What you ask Sitka stays yours. Lecturers see how the room understood, never who asked what.'
                : 'What you ask Sitka stays yours. Leads see how a meeting landed, never who asked what.'}
            </span>
            {org.role !== 'owner' && (
              <button className="link-btn" onClick={() => setConfirmLeave(true)}>
                Leave {org.name}
              </button>
            )}
          </div>
        </div>

        {confirmLeave && (
          <ConfirmDialog
            title={`Leave ${org.name}?`}
            message="You will lose access to its spaces, materials and shared sessions. You can join again with a code."
            confirmLabel="Leave"
            onConfirm={() => {
              setConfirmLeave(false)
              void window.sitka.leaveOrg(org.id).then(onLeft)
            }}
            onCancel={() => setConfirmLeave(false)}
          />
        )}
      </div>
    )
  }

  // ---------------- one space ----------------
  const noun = spaceNoun(active.kind)
  const captureKind: SessionKind = active.kind === 'course' ? 'lecture' : 'meeting'
  return (
    <div className="org-space">
      <div className="org-space-head">
        <button className="link-btn" onClick={() => setActive(null)}>
          ‹ {org.name}
        </button>
        <div className="org-space-title-row">
          <span className="org-card-icon">{kindIcon(active.kind)}</span>
          <div style={{ minWidth: 0, flex: 1 }}>
            <h1 className="page-title" style={{ marginBottom: 2 }}>
              {active.name}
            </h1>
            {active.description && <div className="org-space-desc">{active.description}</div>}
          </div>
          <button
            className="btn btn-primary btn-sm"
            onClick={() => onStartSession(captureKind, false, active.id, active.name)}
            title={`Capture a ${captureKind} into this ${noun}`}
          >
            <IconScreen size={13} strokeWidth={2} />
            {active.kind === 'course' ? 'Capture a lecture' : 'Capture a meeting'}
          </button>
          <button
            className="btn btn-ghost btn-sm"
            onClick={() => onStartSession(captureKind, true, active.id, active.name)}
            title="Audio only"
          >
            <IconMic size={13} strokeWidth={2} />
          </button>
        </div>
        <div className="brain-modes" style={{ marginTop: 12 }}>
          <div className="seg">
            {(
              [
                ['ask', 'Ask'],
                ['sessions', active.kind === 'course' ? 'Lectures' : 'Sessions'],
                ['materials', 'Materials'],
                ...(lead ? [['understanding', 'Understanding']] : []),
                ['people', 'People']
              ] as [Tab, string][]
            ).map(([id, label]) => (
              <button key={id} className={`seg-btn${tab === id ? ' on' : ''}`} onClick={() => setTab(id)}>
                {label}
                {id === 'sessions' && sessions.length > 0 && <span className="seg-n">{sessions.length}</span>}
                {id === 'materials' && materials.length > 0 && <span className="seg-n">{materials.length}</span>}
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="brain-body">
        {tab === 'ask' && (
          <div className="brain-chat">
            <ChatPane
              key={`${active.id}-${chatKey}`}
              sessionId={`__space__${active.id}`}
              brain
              live={false}
              initialChat={[]}
              hasChatKey={hasChatKey}
              hasTranscript
              headerTitle={active.kind === 'course' ? `Ask the course` : `Ask ${active.name}`}
              askOverride={(requestId, question, history) =>
                void window.sitka.askSpace({ spaceId: active.id, requestId, question, history })
              }
              resolveLabel={(sid) => sessions.find((s) => s.id.startsWith(sid))?.title}
              onSeek={(seconds, sid) => {
                if (!sid) return
                const s = sessions.find((x) => x.id.startsWith(sid))
                if (s) onOpenSession(s.id, seconds)
              }}
              onOpenSettings={onOpenSettings}
              suggestions={
                active.kind === 'course'
                  ? [
                      'What did the lecturer say I should focus on for the exam?',
                      'Explain the hardest idea from the last lecture simply',
                      'Which topics did the lectures cover that the slides did not?'
                    ]
                  : [
                      'What did we decide, and why?',
                      'Which promises are still open, and whose are they?',
                      'What changed between the last two meetings?'
                    ]
              }
            />
          </div>
        )}

        {tab === 'sessions' && (
          <div className="brain-results">
            {unfiled.length > 0 && (
              <div className="org-file">
                <IconFolder size={14} />
                <span>File one of your sessions here</span>
                <select className="input" value={fileId} onChange={(e) => setFileId(e.target.value)}>
                  <option value="">Choose a session…</option>
                  {unfiled.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.title} · {formatDate(s.createdAt)}
                    </option>
                  ))}
                </select>
                <button className="btn btn-sm" disabled={!fileId} onClick={() => void fileSession()}>
                  File it
                </button>
              </div>
            )}
            {sessions.length === 0 ? (
              <div className="transcript-waiting">
                {active.kind === 'course'
                  ? 'No lectures yet. Capture one with the button above, and every student in the course can ask it questions.'
                  : 'No sessions yet. Capture a meeting with the button above, and everyone here can ask what was decided.'}
              </div>
            ) : (
              <div className="eco-sessions">
                {sessions.map((s) => (
                  <button key={s.id} className="eco-session" onClick={() => onOpenSession(s.id)}>
                    <span className="eco-session-icon">
                      <IconPlay size={13} strokeWidth={2.2} />
                    </span>
                    <span className="eco-session-title">{s.title}</span>
                    <span className="eco-session-meta">
                      {formatDate(s.createdAt)} · {formatDuration(s.durationMs)}
                    </span>
                  </button>
                ))}
              </div>
            )}
          </div>
        )}

        {tab === 'materials' && (
          <div className="brain-results">
            {lead ? (
              <MaterialsPanel
                materials={materials.map((m) => ({ id: m.id, name: m.name, chars: m.chars, addedAt: m.addedAt }))}
                onAdd={async (name, text) => setMaterials(await window.sitka.addSpaceMaterial(active.id, name, text))}
                onRemove={async (id) => setMaterials(await window.sitka.removeSpaceMaterial(active.id, id))}
              />
            ) : materials.length === 0 ? (
              <div className="transcript-waiting">
                {active.kind === 'course'
                  ? 'Nothing shared yet. When your lecturer uploads slides or readings, Sitka reads them and they appear here.'
                  : 'Nothing shared yet. When a lead uploads documents, Sitka reads them and they appear here.'}
              </div>
            ) : (
              <div className="mat-list">
                {materials.map((m) => (
                  <div key={m.id} className="mat-row">
                    <span className="mat-row-icon">
                      <IconDoc size={14} strokeWidth={1.7} />
                    </span>
                    <span className="mat-row-text">
                      <span className="mat-row-name">{m.name}</span>
                      <span className="mat-row-size">
                        {sizeLabel(m.chars)}
                        {m.addedBy ? ` · added by ${m.addedBy}` : ''}
                      </span>
                    </span>
                  </div>
                ))}
              </div>
            )}
            {materials.length > 0 && (
              <div className="mat-knows" style={{ marginTop: 12 }}>
                <Mark size={13} />
                Sitka has read {materials.length === 1 ? 'this document' : `these ${materials.length} documents`} and uses{' '}
                {materials.length === 1 ? 'it' : 'them'} in every answer about this {noun}.
              </div>
            )}
          </div>
        )}

        {tab === 'understanding' && lead && (
          <div className="brain-results">
            <div className="org-explain">
              <IconSparkle size={14} />
              <span>
                How each session landed with the room, from what people did on their phones during it: who tapped
                “lost me” and what they asked Sitka privately. Counts only, never names. Sessions that were not hosted
                for an audience have nothing to show.
              </span>
            </div>
            {insights === null ? (
              <div className="transcript-waiting">Reading the room…</div>
            ) : insights.length === 0 ? (
              <div className="transcript-waiting">No sessions in this {noun} yet.</div>
            ) : (
              insights.map((i) => (
                <div key={i.sessionId} className="org-insight">
                  <div className="org-insight-top">
                    <button className="link-btn" style={{ fontWeight: 650 }} onClick={() => onOpenSession(i.sessionId)}>
                      {i.title}
                    </button>
                    <span className="org-insight-meta">
                      {formatDate(i.createdAt)} · {formatDuration(i.durationMs)}
                    </span>
                  </div>
                  <div className="org-insight-stats">
                    <span>
                      <b>{i.lost}</b> lost me
                    </span>
                    <span className="org-meta-dot" />
                    <span>
                      <b>{i.asks}</b> private questions
                    </span>
                  </div>
                  {i.questions.length > 0 && (
                    <ul className="org-insight-q">
                      {i.questions.slice(0, 8).map((q, n) => (
                        <li key={n}>{q}</li>
                      ))}
                    </ul>
                  )}
                </div>
              ))
            )}
          </div>
        )}

        {tab === 'people' && (
          <div className="brain-results">
            <div className="org-people">
              {members.map((m) => (
                <div key={m.userId} className="org-person">
                  <span className="org-person-avatar">{(m.name || m.email || '?').slice(0, 1).toUpperCase()}</span>
                  <span className="org-person-text">
                    <span className="org-person-name">{m.name}</span>
                    <span className="org-person-sub">{m.email}</span>
                  </span>
                  <span className="org-person-role">
                    {m.role === 'owner' ? 'Owner' : m.role === 'lead' ? (education ? 'Lecturer' : 'Lead') : education ? 'Student' : 'Member'}
                  </span>
                </div>
              ))}
            </div>
            {lead && (
              <div className="org-danger">
                <button className="btn btn-ghost btn-sm" onClick={() => setConfirmDeleteSpace(active)}>
                  <IconTrash size={13} />
                  Delete this {noun}
                </button>
              </div>
            )}
          </div>
        )}
      </div>

      {confirmDeleteSpace && (
        <ConfirmDialog
          title={`Delete “${confirmDeleteSpace.name}”?`}
          message="Its materials are removed for everyone. Sessions are not deleted; they simply stop being filed here."
          confirmLabel="Delete"
          onConfirm={() => {
            const s = confirmDeleteSpace
            setConfirmDeleteSpace(null)
            void window.sitka.deleteSpace(s.id).then(async () => {
              setActive(null)
              await refresh()
              onChanged()
            })
          }}
          onCancel={() => setConfirmDeleteSpace(null)}
        />
      )}
    </div>
  )
}
