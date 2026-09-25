# Hardening: every finding, and what was done about it

The two pre-launch reports of 25 September 2026 — **Audit** ("Pre-launch system
audit", finding ids S R X E A D P K Q) and **Henry** ("System diagnostic: MVP
readiness", ids W D A X M E) — name the same problems under different numbers.
Every finding from both is listed here once, under the set it is fixed in, with
both ids. A set is only marked done when the whole test suite has passed three
times in a row after it (`node tests/run.mjs --times 3`), with the results in
`tests/RESULTS.md`.

Database changes are in `supabase/migrations/`, written to be run once in the
Supabase SQL editor, additive only: nothing in them deletes a user's row or a
recording. The website works both before and after they are run.

Status: ☐ open · ◐ in progress · ☑ done · ⊘ out of code (needs the owner)

## Set 1 — API: cost, abuse and broken routes

| | Audit | Henry | Finding | Fix |
|---|---|---|---|---|
| ☑ | A1 | A1 | Attendee questions and catch-up fail (`ask.js:73`) | Remove the stray line; smoke test every route |
| ☑ | S3 | A2, A3 | A fake key unlocks platform AI; `/api/chat` open to anyone | Own keys are only the caller's; platform-paid calls need a verified sign-in, or a recap id with a server-built prompt; size caps |
| ☑ | A2 (part) | — | Transcription limited per address, fake key skips limits | Same own-key rule; sign-in required; limits per user |
| ☑ | S11 | A8 | `/api/speak` limit key is caller-chosen, GET synthesises, any origin | Limit keyed by user or event; GET is a configuration check; origins restricted |
| ☑ | S10 | A13 | `/api/drive` fetches arbitrary URLs | Takes a session id; resolves the caller's own files; no redirects; timeouts |
| ☑ | S15 | A10 | `$'` in a title corrupts the shared page | Function replacer |
| ☑ | S21 | — | Unauthenticated error email, leaky errors, trusted host header | Notify needs sign-in (recap visitors: one fixed message); generic errors with a request id; fixed site origin |
| ☑ | — | A9 | Rate limits reset on every cold start | Durable counter in the database (`20260925_01_rate_limits.sql`), memory fallback until it is run |
| ☑ | A6 | A14 | Timeouts add up past 60 s | One deadline per request, passed to every call |
| ☑ | — | A11 | HLS route trusts `index.json` names | Validate names and numbers |
| ☑ | S19 | A12 | Sign-in token in the playlist URL | Short-lived signed playback ticket |
| ☑ | S20 | M16 | Read links last 6 h, uploads 12 h | Read links 2 h, upload links 3 h in batches of 60; the app's player makes fresh links when one lapses mid-watch and carries on from the same moment (the public recap page: Set 5) |
| ☑ | S12 | A5 | 400 upload links, 12 h, no quota, odd keys | Session must be the caller's; key shape validated; quota checked; small batches, short life |
| ☑ | R16 | — | Storage counted twice | Count the whole file or the pieces, not both |
| ☑ | — | A18 | Server errors never reach the alert channel | Server errors written to `client_errors` |
| ☑ | P1 | A15 | Account deletion incomplete, deletes the user anyway | Full table list, recursive storage purge, every step checked, the account last |
| ☑ | S14 | A16 | No `script-src` in the CSP; CDN scripts in the origin | Scripts bundled (jsQR, pdf.js); inline scripts and handlers moved to `pageboot.ts`; full CSP in `vercel.json`; `tests/suites/csp.test.mjs` keeps it so; checked on the live pages after deploy |
| ⊘ | — | A17 | Vercel Hobby: 12 functions, non-commercial | Stay within 12 (helpers are `_` files); move to Pro before charging |

Tests: `tests/suites/api.test.mjs` (every route: refusals, limits, own keys,
tickets, grants, account deletion) and `tests/suites/csp.test.mjs`. Passed 3×
with both builds on 25 September 2026 (`tests/RESULTS.md`, "Set 1").

## Set 2 — Database: who can read and change what

All in `supabase/migrations/` (`00` to `07`), tested on a real Postgres that
replays every older script in order and then runs the migrations twice
(`tests/suites/db.test.mjs`: every row written before is still there after).

| | Audit | Henry | Finding | Fix |
|---|---|---|---|---|
| ☑ | S1 | D3 | A planted recap or event unlocks a private recording | `sitka_shared_owner`, owner checks, guard triggers (`00_recap_privacy`) |
| ☑ | S4 | D4 | Recaps can be listed by anyone; the extension shares on Stop | `sitka_recap(id)`, no table read (`00`); the extension no longer shares on Stop: its card offers "Share the recap…", which opens the session's Share |
| ☑ | S2 | D1, D2, D8, D16, D17 | Self-promotion to owner; readable codes; every member's email; short codes; cascades | Memberships only through functions that set the role; codes hidden by column grants, made by the database (12 characters), guesses counted and slowed; members read their own row; five organisations enforced by the database; deleting puts an organisation in a 30-day bin (`02`) |
| ☑ | S5 | D5 | Events table public, with materials | Table read by its host only; `sitka_event(id)` gives one event's public fields; the event, stage and recap pages use it (`03`) |
| ☑ | S6 | D6, A6 | Attendee questions readable | No room read of questions or answers; the attendee's own page reads through the server with its secret; the room sees shared speaker questions without who asked (`03`) |
| ☑ | S9 | A7 | `/api/ask` upserts any row | Insert only (Set 1); in the database, every attendee write must come from a real attendee of that event, shown by the secret their page sends (`03`) |
| ☑ | S7 | D7 | Stage and replay buckets writable by anyone | Changes only by the host the file name belongs to; no listing; pictures only, 5 MB, on the stage (`04`) |
| ☑ | S16 | D13 | Security-definer functions without `search_path`, callable by anyone | `search_path` fixed on all; execute closed by default, granted per role; `current_plan` no longer callable (`05`) |
| ☑ | S17 | D9 | Course live link, filing into other spaces, insights by `eventId` | Lecturers only, to their own event's page; filing only into a space the owner belongs to (the session is always saved); insights joined on the event's owner (`02`) |
| ☑ | S18 | D10 | Anonymous floods of attendees, messages, votes, telemetry | Joins paced per address and per event; messages, reactions, questions and votes per attendee; error reports and usage events per caller (`03`, `07`) |
| ☑ | D2 | D15 | Missing indexes | 23 indexes; every rule reads the caller once per query (`06`) |
| ☑ | D5 | — | No foreign keys, weak constraints | Links to accounts and status checks, `not valid` so existing rows are untouched (`06`). Recaps and events are left unlinked: the retired desktop app wrote some without an account |
| ☑ | X3 | D12 | Deleting a session leaves its recap public | Trigger removes recap and replay (`00`) |
| ☑ | S12 | D14 | Usage counted from values the client writes | The server counts questions and transcribed seconds in `usage_meter`; hours are the longer of the sessions and the transcribed audio; a question is refused when the plan cannot be checked (transcription is not, so a lecture is never cut); non-numbers in sessions no longer break the sums (`07`) |
| ☑ | P4 | — | No retention | Nightly clean-up (errors 90 days, usage 13 months, a room's anonymous traces a year after the event, the bin after 30 days), scheduled with pg_cron (`07`) |
| ☑ | D1 | — | No migration history; re-runs change rules | `supabase/migrations/` with a README; the old scripts in `supabase/legacy/` with a do-not-run note |
| ☑ | D6 | — | Stale duplicate folder | Deleted (the files were identical to the top-level copies) |
| ⊘ | D4 | — | No backups on the Free plan | `scripts/backup-db.mjs` copies every table to `backups/` (git-ignored); Pro with point-in-time recovery when upgrading |

Run order for the owner: deploy the site, then run `00` to `07` in the SQL
editor, then rebuild the extension. Known limit: captions of a live event
remain readable to anyone while it is live (the room is public by link).

## Set 3 — Recording: nothing lost, and the recorder tells the truth

| | Audit | Henry | Finding | Fix |
|---|---|---|---|---|
| ☐ | — | W1 | Only piece 0 carries the header | The header is saved on its own the moment it exists; playback repairs from it |
| ☐ | R1 | M3 | Piece numbers from a listing; overwrites | Numbers from a stored counter; uploads refuse to overwrite |
| ☐ | R2 | — | A failed device read deletes the copy | "Read failed" kept apart from "empty"; unsent pieces never deleted |
| ☐ | R3 | — | "In the cloud up to" can lie; live failures not retried | Gap-free watermark; live retries with backoff |
| ☐ | R4 | W4, M1 | Memory-only pieces never retried; memory grows | One retry queue including memory pieces; memory copy dropped once the device copy is confirmed |
| ☐ | R5, R6 | W5, M15 | Joins with missing pieces, never rebuilt | Join refused while pending or gapped; rebuilt when a late piece lands |
| ☐ | R7 | M4 | No upload timeout; Stop hangs; whole-backlog reads | Timeouts, ranged reads, two uploads at a time |
| ☐ | R8 | W2 | Permanent device copy not checked | `persisted()` checked; warned before recording; quota warning |
| ☐ | R9 | M6, D11 | Session row insert not retried; updates of nothing count as saved | Insert retried; saves detect "no row" and re-insert |
| ☐ | R10 | X13 | Another device ends a live recording | Heartbeat; only a silent session is closed, after 10 minutes |
| ☐ | R11 | — | Two tabs split pieces differently | Piece record written when formed; one uploader per session (Web Locks) |
| ☐ | R13 | W3 | One failed storage check sends everything to Supabase | Failures not cached; the store fixed per session |
| ☐ | R14 | W10 | Delete incomplete, races uploads | Tombstone first; uploads check it; batched deletes |
| ☐ | R17 | — | Device-copy warning vanishes | Separate state |
| ☐ | R18 | W11, W12 | Wall-clock duration, same numbers, stale grants, cached failed open, cut-short tail | Handled in the engine rework |
| ☐ | — | M2 | Recovery sweep loads every chunk | Sweeps by keys only |
| ☐ | — | X9 | Recording needs the network to start | Recording starts under a local id; the row is created in the background |
| ☐ | — | W13 | Text backups in 5 MB localStorage | Backups in IndexedDB |

## Set 4 — Sessions, sync and the library

| | Audit | Henry | Finding | Fix |
|---|---|---|---|---|
| ☐ | R12 | W8 | Whole `meta` saved from stale copies | Only changed fields are sent, merged on the server |
| ☐ | A4 | W7 | Whole transcript rewritten every 3 s | New lines appended on the server |
| ☐ | X10 | — | Chat saves from two devices lose messages | Appended and merged on the server |
| ☐ | X1 | X12 | Shared computer: next user sees and uploads the previous user's data | Everything local tagged with the user; cleared or refused at sign-out |
| ☐ | X2 | — | A deleted session comes back from a backup | Backups are a retry queue, never list entries |
| ☐ | X5 | — | List does not refresh across devices | Refresh on focus and on change |
| ☐ | X6 | — | A network blip looks like a deleted session | "Not found" kept apart from "failed" |
| ☐ | X7 | W9, M8, M9 | Every open downloads the whole library; 1,000-row cut | Light list query, paged; stuck check on the server |
| ☐ | — | M10 | Status is a guess | One recording state shown everywhere |
| ☐ | — | M11 | Open session polls the full row every 3 s | Light status poll |
| ☐ | — | W14 | Health check blocks startup | Not blocking; re-checked on use |

## Set 5 — Playback and phones

| | Audit | Henry | Finding | Fix |
|---|---|---|---|---|
| ☐ | X4 | M5 | Locking the phone silently stops recording | Keep-open notice; flush on hide; resume on return; gap marked; duration from the media |
| ☐ | R15 | W6, M12, M13 | Whole recordings joined and played from memory | Never on phones; capped elsewhere; streams and playlists instead |
| ☐ | — | M14 | The app never tries HLS on iPhone | HLS first on iOS |
| ☐ | — | M16 | Expired links retried forever | Links renewed on 403 |
| ☐ | — | M17 | Video downloaded before play; 8 minutes buffered while paused | Nothing fetched before play on metered connections; small buffer |
| ☐ | — | M18 | Playlist not checked against the parts | Sizes checked |
| ☐ | X8 | — | WebM does not play on iPhone | MP4 recorded wherever the browser can; WebM sessions marked as such |
| ☐ | X9 | — | Uploads over mobile data unchecked | "Upload on Wi-Fi only" setting |
| ☐ | X11 | — | Home-screen app named as Safari | Standalone detected |
| ☐ | X12 | — | Zoom blocked; quick taps dropped; no offline page | Zoom allowed; guard per element; offline page |

## Set 6 — Chrome extension

| | Audit | Henry | Finding | Fix |
|---|---|---|---|---|
| ☐ | E1 | X4 | Participants never told | Consent before first use; "tell the room"; visible notice |
| ☐ | S4 (part) | D4 (part) | Recap published on Stop without asking | Link made unlisted; shared only when the user shares |
| ☐ | E2 | X11 | Leave detected only in English | Language-independent end signal; grace period |
| ☐ | E3 | — | Captions depend on hidden class names | "No captions for N minutes" reported; the user's caption setting restored |
| ☐ | E4 | X1 | Pieces never retried after the call | `unlimitedStorage`; drained on startup and on an alarm; engine kept while pending |
| ☐ | — | X2 | No engine heartbeat | Status every 10 s; card says "stopped" when stale |
| ☐ | — | X3 | Stop during start still records | Start tokens acknowledged; cancelled set |
| ☐ | — | X6 | Slow ping deletes the card mid-recording | Card rebuilt from the engine; stream never released while recording |
| ☐ | — | X7 | Card in the page DOM accepts untrusted clicks | Closed shadow root; trusted events only |
| ☐ | — | X8 | User's microphone starts muted | Follows Meet's mute state |
| ☐ | — | X10 | Heavy jobs run in the engine during calls | Skipped in the engine |
| ☐ | E5 | — | Recording in the side panel dies with it | Recording handed to the engine |
| ☐ | E6 | — | Zip paths, pinned key | Forward-slash zip; key stripped for store builds |
| ☐ | E7 | X14 | Sender not checked; look-alike domains; `tabs` | Sender checked; patterns anchored |
| ☐ | — | X5 | Remote code in the package vs the listing | Google/Firebase loaders excluded from the extension build; listing corrected |
| ☐ | — | X12 | Update mid-call; sign-out mid-recording | Updates deferred while recording; sign-out refused while pending |

## Set 7 — Live AI and the app

| | Audit | Henry | Finding | Fix |
|---|---|---|---|---|
| ☐ | A2 | — | Failed transcription pieces dropped; per-IP limits break classrooms | Queued with backoff; limits per user |
| ☐ | A3 | — | One crash stops the recording | Each pane has its own boundary; the recorder survives |
| ☐ | A5 | — | Uncapped transcripts to the AI | Excerpts and digests everywhere |
| ☐ | A7 | — | Re-sorting, unrevoked URLs, translations marked done on failure | Fixed |

## Set 8 — Privacy and legal

| | Audit | Henry | Finding | Fix |
|---|---|---|---|---|
| ☐ | P2 | — | Attendee notice says questions stay private | Wording corrected |
| ☐ | P3 | — | Privacy page lists 3 of 12 sub-processors | Full list |
| ☐ | S22 | — | Links in AI documents not checked | Quotes escaped; https only |

## Set 9 — Desktop app

| | Audit | Henry | Finding | Fix |
|---|---|---|---|---|
| ☐ | S13, K1–K4 | E1–E12 | Service-role key, unsafe writes, crashes, open local server | Retired for the MVP: the service key is refused, online features point to the website, the installer is not distributed; safe writes and id checks kept for anyone still running it |

## Set 10 — How changes are made

| | Audit | Henry | Finding | Fix |
|---|---|---|---|---|
| ☐ | Q1 | A18 | No tests, no CI, no monitoring | `tests/` suite, CI on every push, server errors reported |
| ☐ | Q2 | — | Errors swallowed on the data path | Each one on the data path surfaced or retried |
| ☐ | Q3 | — | Very large files | The recorder and its storage moved out of `webApi.ts` |
| ☐ | Q4 | — | Docs out of date | README, STORAGE.md, domain-move checklist |
