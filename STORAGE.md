# Where Sitka keeps things

Sitka stores two kinds of thing in two places, and they are chosen for
different reasons.

**Supabase** holds everything small and structured: accounts and sign-in,
sessions, transcripts, recaps, chapters, questions, every word the AI writes,
and the usage figures behind the operations dashboard. It is the brain, and it
stays exactly as it was.

**Cloudflare R2** holds the heavy things: the recordings themselves and the
frames taken off the screen. R2 was chosen for one reason above the others.
It does not charge for data leaving it, and a lecture that fifty students watch
back is almost entirely data leaving.

Nothing passes through a Sitka server in either direction. The browser asks
`/api/storage` for a link, and then talks to R2 itself.

A recording made before this change is still in Supabase and still plays.
Every read tries R2 first and falls back, so nothing had to be migrated.

## Setting it up

### 1. Make the bucket

In the Cloudflare dashboard, open **R2** and create a bucket named `sitka`.
Leave it private. Nothing needs to be public for this to work.

### 2. Let the browser talk to it

R2 has to be told which site may upload and download. Still in R2, open the
bucket, then **Settings**, then **CORS policy**, and paste this, replacing the
first origin with your own domain if you have one:

```json
[
  {
    "AllowedOrigins": ["https://sitka-blue.vercel.app", "http://localhost:5173"],
    "AllowedMethods": ["GET", "PUT", "HEAD"],
    "AllowedHeaders": ["*"],
    "ExposeHeaders": ["ETag", "Content-Length", "Content-Range", "Accept-Ranges"],
    "MaxAgeSeconds": 3600
  }
]
```

This step is not optional. Without it uploads fail and recordings will not
stream, with no error message worth reading.

### 3. Make an access key

In R2, open **Manage R2 API Tokens**, create a token with **Object Read &
Write** limited to the `sitka` bucket, and keep the three values it shows you.
They are shown once.

### 4. Tell Vercel

Add these in the Vercel project, under Settings then Environment Variables, for
Production and Preview both:

| Name | Value |
|---|---|
| `R2_ACCOUNT_ID` | the account id shown on the R2 overview page |
| `R2_ACCESS_KEY_ID` | from the token you just made |
| `R2_SECRET_ACCESS_KEY` | from the token you just made |
| `R2_BUCKET` | `sitka` |
| `SUPABASE_URL` | the same URL the app already uses |
| `SUPABASE_ANON_KEY` | the same anon key the app already uses |

The last two are how this endpoint checks who is asking. It never sees a
service key, and it cannot read or change anything in the database.

### 5. Check it

Open `https://<your site>/api/storage` in a browser. It should say
`"configured": true` and `"supabase": true`. Nothing secret is reported.

Then record a short session and open it on a phone. If it plays, it is done.

## Who can read what

It is enforced in `web/api/storage.js`, and for recordings still in Supabase by
the storage policy in `supabase/recap-privacy.sql`:

- the owner may read and write anything inside their own folder;
- anyone with the link may read a session whose recap the owner has shared,
  or whose event replay is switched on, but only from that owner's folder,
  and only when the person who shared it is the person who recorded it
  (`sitka_shared_owner` in the database decides);
- a member of a course may watch the sessions filed in it;
- nobody may read anything else, and no unsigned request reaches R2 at all.

A recap is read one at a time, by its id (`sitka_recap`). The recaps table
cannot be listed, so a recap can be found only by someone who was given its
link. Deleting a session deletes its recap and switches off its event replay.

Links are signed and expire: six hours for reading, twelve hours for the
upload links a recording is given when it starts.

## What it is expected to cost

Screen capture runs at about 231 MB an hour, camera about 434 MB, and audio
alone about 29 MB. R2 gives 10 GB free, then charges $0.015 per GB each month,
and nothing for the watching.

A hundred students recording five hours each of screen capture comes to roughly
115 GB, which is about $1.60 a month. The same thing on Supabase's free plan
does not fit at all, and its per-file limit of 50 MB cuts off a screen
recording after about thirteen minutes.

## The one part still on Supabase

Publishing a replay **from the desktop app** still uploads to the Supabase
`replays` bucket, because the desktop app signs in with a service key and
cannot use this endpoint. On the free plan that upload fails for anything over
50 MB. Host from the web app while that is true.

Live room stage frames are also still in Supabase. They are single small JPEGs,
overwritten in place, and cost nothing.

## Moving an existing library in one go

The app moves older recordings on its own, one file at a time, whenever it is
open on a laptop. For a whole library at once, run the script instead. It works
server to server, four files at a time, and checks every copy before removing
the original.

Create a file named `.env.migrate` in the project root (git ignores it) with
the six values named at the top of `scripts/move-recordings.mjs`, then:

```bash
node scripts/move-recordings.mjs --dry-run
node scripts/move-recordings.mjs
```

Do not record while it runs. Run it again if anything failed; it only touches
what is still in Supabase.
