# Old database scripts: do not run

These are the scripts the live database was built with, one after another,
before `supabase/migrations/` existed. They are kept as the record of how it
got here, and so the tests can rebuild the same database
(`tests/lib/supadb.mjs` replays them in order, then the migrations).

**Do not run any of them again.** Several re-create rules under names that
later scripts changed, so running an old one now can quietly reopen something
that was closed. For example, `hardening.sql` brought back the policy that
let anyone read attendees' questions, which `wave16.sql` had removed.
Every change from now on is a new file in `supabase/migrations/`.

The order they were run in:

```
schema, host-upgrade, app-upgrade,
wave2 … wave18,
admin, hardening, plans, courses, orgadmin, keeplive,
fix-replays, fix-stage
```
