import React, { useCallback, useEffect, useState } from 'react'
import type { OrgOverview, Organization } from '@shared/types'
import ConfirmDialog from './ConfirmDialog'
import { formatDate } from '../lib/format'
import { IconCopy } from '../lib/icons'

interface Props {
  org: Organization
  /** which part of the administration this shows: the workspace page keeps each on its own tab */
  section: 'overview' | 'people' | 'settings'
  /** open a course or space */
  onOpenSpace: (id: string) => void
  /** something changed that the parent lists (members, name, codes) */
  onChanged: () => void
}

const SITE = 'https://sitcaai.vercel.app'

/**
 * The organisation, as its administration sees it: the month in numbers,
 * every course and how busy it is, every person and what they may do, the
 * rules of the house, and the invitation codes. The owner may change what
 * is shown; lecturers and leads see it as it is.
 */
export default function OrgAdmin({ org, section, onOpenSpace, onChanged }: Props): React.JSX.Element {
  const education = org.kind === 'education'
  const owner = org.role === 'owner'
  const [data, setData] = useState<OrgOverview | null>(null)
  const [loaded, setLoaded] = useState(false)
  const [filter, setFilter] = useState('')
  const [note, setNote] = useState('')
  const [copied, setCopied] = useState('')
  const [removing, setRemoving] = useState<OrgOverview['members'][number] | null>(null)
  const [newCodes, setNewCodes] = useState(false)
  const [domains, setDomains] = useState('')
  const [renaming, setRenaming] = useState(false)
  const [nameDraft, setNameDraft] = useState(org.name)

  const load = useCallback(async () => {
    const o = await window.sitka.orgOverview(org.id).catch(() => null)
    setData(o)
    if (o) setDomains(o.domains.join(', '))
    setLoaded(true)
  }, [org.id])
  useEffect(() => {
    void load()
  }, [load])

  const say = (m: string): void => {
    setNote(m)
    window.setTimeout(() => setNote(''), 3200)
  }
  const copy = (text: string, key: string): void => {
    void navigator.clipboard.writeText(text)
    setCopied(key)
    window.setTimeout(() => setCopied(''), 1600)
  }
  const roleWord = (r: string): string =>
    r === 'owner' ? 'Owner' : r === 'lead' ? (education ? 'Lecturer' : 'Lead') : education ? 'Student' : 'Member'

  if (!loaded) return <div className="org-admin-wait">Gathering the organisation…</div>
  if (!data) {
    return (
      <div className="notice">
        <span>
          <strong>The administration view is not ready on this server.</strong> Run <code>supabase/legacy/orgadmin.sql</code> once in the SQL editor, then reload.
        </span>
      </div>
    )
  }

  const leads = data.members.filter((m) => m.role === 'lead' || m.role === 'owner').length
  const students = data.members.filter((m) => m.role === 'member').length
  const q = filter.trim().toLowerCase()
  const people = q ? data.members.filter((m) => `${m.name} ${m.email}`.toLowerCase().includes(q)) : data.members
  const ago = (t: number | null): string => {
    if (!t) return 'never'
    const d = Math.floor((Date.now() - t) / 86400000)
    return d === 0 ? 'today' : d === 1 ? 'yesterday' : d < 30 ? `${d} days ago` : formatDate(t)
  }

  return (
    <div className="org-admin">
      {section === 'settings' && (
        <div className="org-admin-head">
          <div>
            <div className="section-title" style={{ marginTop: 0 }}>
              Settings
            </div>
            <div className="org-admin-sub">
              {education ? 'The name, who may join, who makes courses, and the codes that let people in.' : 'The name, who may join, and the codes that let people in.'}
            </div>
          </div>
          {owner && (
            <button className="btn btn-ghost btn-sm" onClick={() => setRenaming(true)}>
              Rename
            </button>
          )}
        </div>
      )}

      {/* the month, in numbers: one quiet line, not a wall of tiles */}
      {section === 'overview' && (
        <div className="org-kpis">
          <div className="org-kpi">
            <b>{data.month.sessions}</b>
            <span>sessions this month</span>
          </div>
          <div className="org-kpi">
            <b>{data.month.hours}</b>
            <span>hours captured</span>
          </div>
          <div className="org-kpi">
            <b>{data.month.asks}</b>
            <span>questions asked</span>
          </div>
          <div className="org-kpi">
            <b>{data.month.active}</b>
            <span>people active</span>
          </div>
          <div className="org-kpi">
            <b>{data.courses.length}</b>
            <span>{education ? (data.courses.length === 1 ? 'course' : 'courses') : data.courses.length === 1 ? 'space' : 'spaces'}</span>
          </div>
          <div className="org-kpi">
            <b>{leads + students}</b>
            <span>
              {leads} {education ? (leads === 1 ? 'lecturer' : 'lecturers') : leads === 1 ? 'lead' : 'leads'} · {students}{' '}
              {education ? (students === 1 ? 'student' : 'students') : students === 1 ? 'member' : 'members'}
            </span>
          </div>
        </div>
      )}

      {/* the courses */}
      {section === 'overview' && <div className="section-title">{education ? 'Courses' : 'Spaces'}</div>}
      {section !== 'overview' ? null : data.courses.length === 0 ? (
        <div className="org-admin-empty">{education ? 'No courses yet. Lecturers make them from the top of this page.' : 'No spaces yet.'}</div>
      ) : (
        <div className="org-table">
          <div className="org-tr org-th">
            <span>Name</span>
            <span>{education ? 'Lecturers' : 'Leads'}</span>
            <span>{education ? 'Students' : 'People'}</span>
            <span>Sessions</span>
            <span>Documents</span>
            <span>Last session</span>
          </div>
          {data.courses.map((c) => (
            <button key={c.id} className="org-tr" onClick={() => onOpenSpace(c.id)} title="Open">
              <span className="org-td-name">
                {c.name}
                {c.liveUrl && <span className="live-badge org-td-live">● LIVE</span>}
              </span>
              <span>{c.lecturers.length ? c.lecturers.join(', ') : '—'}</span>
              <span>{c.students}</span>
              <span>{c.sessions}</span>
              <span>{c.materials}</span>
              <span>{c.lastSession ? formatDate(c.lastSession) : '—'}</span>
            </button>
          ))}
        </div>
      )}

      {/* the people */}
      {section === 'people' && (
      <>
      <div className="org-admin-row">
        <div className="section-title" style={{ marginTop: 0 }}>People</div>
        <input className="input org-admin-find" placeholder="Find by name or email" value={filter} onChange={(e) => setFilter(e.currentTarget.value)} />
      </div>
      <div className="org-table">
        <div className="org-tr org-th org-tr-people">
          <span>Person</span>
          <span>Role</span>
          <span>{education ? 'Courses' : 'Spaces'}</span>
          <span>Sessions</span>
          <span>Last seen</span>
          <span />
        </div>
        {people.map((m) => (
          <div key={m.userId} className="org-tr org-tr-people">
            <span className="org-td-person">
              <span className="org-person-avatar">{(m.name || m.email || '?').slice(0, 1).toUpperCase()}</span>
              <span className="org-person-text">
                <span className="org-person-name">{m.name || m.email}</span>
                <span className="org-person-sub">
                  {m.email}
                  {m.joinedAt ? ` · joined ${formatDate(m.joinedAt)}` : ''}
                </span>
              </span>
            </span>
            <span>
              {owner && m.role !== 'owner' ? (
                <select
                  className="org-role-sel"
                  value={m.role}
                  onChange={(e) => {
                    const role = e.currentTarget.value === 'lead' ? 'lead' : 'member'
                    void window.sitka.setOrgMemberRole(org.id, m.userId, role).then((r) => {
                      if (r.error) say(r.error)
                      else {
                        say(`${m.name || m.email} is now ${roleWord(role).toLowerCase() === 'lecturer' ? 'a lecturer' : roleWord(role).toLowerCase() === 'lead' ? 'a lead' : roleWord(role).toLowerCase() === 'student' ? 'a student' : 'a member'}.`)
                        void load()
                        onChanged()
                      }
                    })
                  }}
                >
                  <option value="lead">{education ? 'Lecturer' : 'Lead'}</option>
                  <option value="member">{education ? 'Student' : 'Member'}</option>
                </select>
              ) : (
                <span className="org-person-role">{roleWord(m.role)}</span>
              )}
            </span>
            <span>{m.courses}</span>
            <span>{m.sessions}</span>
            <span>{ago(m.lastSeen)}</span>
            <span className="org-td-actions">
              {m.role !== 'owner' && (owner || m.role === 'member') && (
                <button className="link-btn" onClick={() => setRemoving(m)}>
                  Remove
                </button>
              )}
            </span>
          </div>
        ))}
        {people.length === 0 && <div className="org-admin-empty">Nobody matches.</div>}
      </div>
      </>
      )}

      {/* the rules, and the way in */}
      {section === 'settings' && owner && (
        <div className="org-admin-cards">
          <div className="invite-card">
            <div className="invite-card-head">
              <span className="invite-card-who">Who may join</span>
              <span className="invite-card-desc">
                {education
                  ? 'An email students must join with, such as students.cavendish.ac.ug — leave empty for any address. Several, separated by commas.'
                  : 'An email people must join with, such as acme.com — leave empty for any address.'}
              </span>
            </div>
            <div className="invite-actions" style={{ gap: 8 }}>
              <input className="input" style={{ flex: 1, minWidth: 160 }} placeholder="students.cavendish.ac.ug" value={domains} onChange={(e) => setDomains(e.currentTarget.value)} spellCheck={false} />
              <button
                className="btn btn-sm"
                onClick={() => {
                  const list = domains
                    .split(/[,\s]+/)
                    .map((d) => d.trim().toLowerCase().replace(/^@/, ''))
                    .filter((d) => /^[a-z0-9.-]+\.[a-z]{2,}$/.test(d))
                  void window.sitka.setOrgRules(org.id, list, data.coursesBy).then((r) => {
                    if (r.error) say(r.error)
                    else {
                      say(list.length ? `Only ${list.join(', ')} addresses may join.` : 'Any address may join.')
                      void load()
                      onChanged()
                    }
                  })
                }}
              >
                Save
              </button>
            </div>
          </div>
          {education && (
            <div className="invite-card">
              <div className="invite-card-head">
                <span className="invite-card-who">Who may create courses</span>
                <span className="invite-card-desc">Lecturers make their own courses, or the administration makes them all.</span>
              </div>
              <div className="invite-actions" style={{ gap: 8 }}>
                {(['leads', 'owner'] as const).map((v) => (
                  <button
                    key={v}
                    className={`btn btn-sm${data.coursesBy === v ? '' : ' btn-ghost'}`}
                    onClick={() => {
                      void window.sitka.setOrgRules(org.id, data.domains, v).then((r) => {
                        if (r.error) say(r.error)
                        else {
                          say(v === 'leads' ? 'Lecturers may create courses.' : 'Only the administration creates courses.')
                          void load()
                          onChanged()
                        }
                      })
                    }}
                  >
                    {v === 'leads' ? 'Lecturers' : 'Administration only'}
                  </button>
                ))}
              </div>
            </div>
          )}
          {data.code && data.leadCode && (
            <div className="invite-card">
              <div className="invite-card-head">
                <span className="invite-card-who">Invitation codes</span>
                <span className="invite-card-desc">
                  People join at {SITE.replace('https://', '')} → {education ? 'Education' : 'Business'} → “Join with a code”. New codes stop the old ones.
                </span>
              </div>
              <div className="org-codes">
                <div className="org-code">
                  <span>{education ? 'Students' : 'Members'}</span>
                  <code>{data.code}</code>
                  <button className="btn btn-ghost btn-sm" onClick={() => copy(data.code!, 'code')}>
                    <IconCopy size={12} />
                    {copied === 'code' ? 'Copied' : 'Copy'}
                  </button>
                </div>
                <div className="org-code">
                  <span>{education ? 'Lecturers' : 'Leads'}</span>
                  <code>{data.leadCode}</code>
                  <button className="btn btn-ghost btn-sm" onClick={() => copy(data.leadCode!, 'lead')}>
                    <IconCopy size={12} />
                    {copied === 'lead' ? 'Copied' : 'Copy'}
                  </button>
                </div>
              </div>
              <div className="invite-actions">
                <button className="btn btn-ghost btn-sm" onClick={() => setNewCodes(true)}>
                  New codes
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {note && <div className="org-admin-note">{note}</div>}

      {removing && (
        <ConfirmDialog
          title={`Remove ${removing.name || removing.email}?`}
          message={
            education
              ? 'They leave the university and every course in it. Their own sessions stay in their library.'
              : 'They leave the organisation and every space in it. Their own sessions stay in their library.'
          }
          confirmLabel="Remove"
          onCancel={() => setRemoving(null)}
          onConfirm={() => {
            const m = removing
            setRemoving(null)
            void window.sitka.removeOrgMember(org.id, m.userId).then((r) => {
              if (r.error) say(r.error)
              else {
                say(`${m.name || m.email} was removed.`)
                void load()
                onChanged()
              }
            })
          }}
        />
      )}
      {newCodes && (
        <ConfirmDialog
          title="New invitation codes?"
          message="The codes you have shared stop working. People already in stay in."
          confirmLabel="Make new codes"
          onCancel={() => setNewCodes(false)}
          onConfirm={() => {
            setNewCodes(false)
            void window.sitka.newOrgCodes(org.id).then((r) => {
              if (r.error) say(r.error)
              else {
                say('New codes are in place.')
                void load()
                onChanged()
              }
            })
          }}
        />
      )}
      {renaming && (
        <div className="dialog-overlay" onMouseDown={() => setRenaming(false)}>
          <div className="dialog" onMouseDown={(e) => e.stopPropagation()}>
            <div className="dialog-title">Rename {org.name}</div>
            <input className="input" value={nameDraft} onChange={(e) => setNameDraft(e.currentTarget.value)} autoFocus />
            <div className="dialog-actions">
              <button className="btn btn-ghost" onClick={() => setRenaming(false)}>
                Cancel
              </button>
              <button
                className="btn btn-primary"
                disabled={nameDraft.trim().length < 2}
                onClick={() => {
                  setRenaming(false)
                  void window.sitka.renameOrg(org.id, nameDraft.trim()).then((r) => {
                    if (r.error) say(r.error)
                    else {
                      say('Renamed.')
                      onChanged()
                    }
                  })
                }}
              >
                Save
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
