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

## Order for a release

1. Deploy the website (it reads the new functions and falls back to the old
   reads until they exist).
2. Run the new migrations here, in order.
3. Rebuild and upload the Chrome extension, which carries its own copy of the app.
