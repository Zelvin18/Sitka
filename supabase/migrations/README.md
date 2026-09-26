# Database migrations

Every change to the database is a file here, named
`YYYYMMDD_NN_what.sql`, run once, in name order, in the Supabase SQL editor.
The scripts in `../legacy/` are history and are never run again.

Each migration:

- is safe to run more than once (a second run changes nothing);
- only adds or tightens: no row a person wrote is deleted, and no recording is touched;
- leaves the website working before and after it runs, so the site is
  deployed first and the migration run after.

`node tests/run.mjs` builds the database from `../legacy/` and runs every
migration here twice over, then checks the rules (`tests/suites/db.test.mjs`).
A migration is not finished until that passes.

## The migrations, in order

| File | What it does |
|---|---|
| `20260925_00_recap_privacy.sql` | recaps read one at a time; shares tied to the sharer's own sessions; a deleted session takes its shares |
| `20260925_01_rate_limits.sql` | a rate-limit counter the server keeps in the database |
| `20260925_02_organisations.sql` | memberships only through functions; codes hidden, long and slowed; the organisation bin; course live links; filing |
| `20260925_03_events.sql` | events read by their host only (one event's public fields for everyone else); attendees' writes need their secret; the room without names |
| `20260925_04_storage_buckets.sql` | stage and replay files changed only by their host |
| `20260925_05_functions.sql` | a fixed search path on every raised-rights function; functions closed by default, opened per role |
| `20260925_06_indexes_constraints.sql` | indexes; status checks; account links (new rows only) |
| `20260925_07_usage_retention.sql` | use counted by the server; sane session numbers; the nightly clean-up |
| `20260925_08_functions_again.sql` | part 5 again, one function at a time (on the live database the SQL editor undid part 5 when it met a function not ours to change); ends by listing what visitors may run |
| `20260926_09_reaudit.sql` | the second audit: invitation previews work again; deleted sessions stay deleted; orphaned recaps switched off; stray owner rows made memberships; a record of which migrations ran (`schema_migrations`) |
| `20260926_10_limits.sql` | limits on what anyone can write (small error reports, a ceiling for visitors, session sizes); callers told apart by an address they cannot name; functions made later start closed; old checks validated; long lead codes; spaces coded by the database |
| `20260926_11_live_events.sql` | a live event's room read by its id only; new lines on the event's private channel; live video on two private channels; attendees carry a secret; the older recordings bucket no longer listable by visitors |

## Order for a release

1. Deploy the website (it reads the new functions and falls back to the old
   reads until they exist).
2. Run the new migrations here, in order.
3. Rebuild and upload the Chrome extension, which carries its own copy of the app.
4. Run `../checks/verify-live.sql` (read-only) and keep what it shows with the
   release notes: it says what the live database really holds.
5. After part 11 has run, and the new pages are live: in the Supabase
   dashboard, Realtime settings, switch off "Allow public access", so only the
   private channels (with their rules) can be joined.

Parts 2 and 5 are run once, in order; running one of them again is followed by
running 08 and everything after it again.
