# Sitca — the professional release

The agreed plan, in the order it is being built, so nothing is fixed and then
forgotten. Each line is ticked when it is live on sitcaai.vercel.app. Anything
found broken along the way goes under **Found on the way** and is fixed before
the phase is called done.

## Phase 1 — Information architecture (organise by job, not by feature)

- [x] Sidebar: Home · Library · Live · Insights · Studio · Workspace (when in an organisation) · Settings
- [x] Live hub: Join a session · Host an event · Send Sitca (Plus; coming) · live now · the events you host
- [x] Studio hub: Make from a session · Practise a talk (the old Create and Coach pages live under it)
- [x] "Overview" is **Insights** everywhere (sidebar, profile menu, command palette, page)
- [x] Session page tabs in reading order: Overview · Notes · Transcript · Ask; **Study** only for lectures and education
- [x] The record button waits on Home only
- [ ] Share & export: Download · Save to Drive · Share · Copy · Export become one sheet on the session page
- [ ] Ecosystem doors (Business / Education) stay reachable from "Sitca for", not as pages of the app
- [ ] Old recap page (`replay.html`) and "convert for phones" removed; `replay2` is the recap
- [ ] Code generation removed from Studio ("Make from this" keeps documents and decks)

## Phase 2 — Trust (the cheapest, highest-return work)

- [ ] Own domain (sitca.ai or sitcaai.com): site, sender email, OAuth redirects, extension host permissions
- [ ] Company page: who, where, a named founder, a real address
- [ ] Security & Data page: where recordings live, encryption, access, retention, deletion, sub-processors
- [ ] Consent: a visible "captured with Sitca" line for attendees; host-side consent prompt
- [ ] Pricing page: four plans side by side, currency, yearly, Institution "talk to us", NGO and education pricing
- [ ] Status & reliability page

## Phase 3 — Package the product for each buyer

- [ ] Education page led by the institution story (admin, licence, pooled hours)
- [ ] Business page: decisions & owners, weekly digest, Teams/Slack recap post
- [ ] **NGO & international organisations page**: field meetings, many languages, poor connections, WhatsApp recaps, NGO price
- [ ] Events page led by the organiser's report
- [ ] Each page: one hero, three outcomes, one real screenshot, one price, one "Talk to us"

## Phase 4 — Features that make an organisation say yes

- [ ] Sign in with Microsoft / Google Workspace; domain-joined workspaces
- [ ] Roles, retention policy and external-sharing rules per workspace
- [ ] Export and portability: a session, and a whole workspace
- [ ] Meeting templates: Board meeting · Field visit · Donor call · Lecture · Training
- [ ] Action items with owners and a follow-up nudge; "Decisions & owners" block on meeting overviews
- [ ] Calendar (Google / Outlook): Sitca knows the next meeting and offers to sit in
- [ ] Admin usage and audit view (who recorded what, hours, storage)
- [ ] Public API / webhooks (later)

## Phase 5 — Send Sitca (attend for me)

- [ ] `send.mjs`: a real browser joins a Google Meet as "Sitca (notes for {name})", tab-captures, feeds a real session
- [ ] Runs on Oracle Cloud Always Free; one browser per meeting; reconnects
- [ ] Live hub: "Send Sitca" takes a link and a time; "Join with Sitca" on every join
- [ ] Scheduling: a meeting set for Friday 3pm is joined (or knocked on) when it goes live
- [ ] Heartbeat handover: the extension records; if the person leaves or loses power, the bot's capture continues the same session
- [ ] Library: "Sitca is live for you" card with a way in; the debrief lands when the meeting ends
- [ ] Bot hours as a plan meter: Free 0 · Plus 5 · Pro 30 · Institution pooled
- [ ] Zoom and Teams after Meet

## Phase 6 — Polish that signals "high level"

- [ ] One voice everywhere, including errors
- [ ] Real screenshots on the marketing pages (the store-kit pipeline)
- [ ] Empty states that teach (a new workspace: invite · template · record)
- [ ] One onboarding across web, extension and phone
- [ ] `sitka` → `sitca` in paths and ids where a person could read them

## Found on the way

- [x] **A 48-minute recording was lost (Sep 24).** Every per-piece upload link was refused for 45 minutes, nobody was told during the session, and the device copy was later evicted. Rebuilt (427bf97): links issued once for the whole session, persistent device copy, a failed device copy said at once, "in the cloud up to…" and a warning while recording.
- [x] The sidebar hid sessions filed under Education/Business, which read as data loss. It now lists everything, tagged.
- [x] "Upload now" was offered on browsers that held nothing to upload. The banner now says where the recording is.
- [ ] Prove the new flow with a real 10-minute recording on the website and on the extension before calling it done.
