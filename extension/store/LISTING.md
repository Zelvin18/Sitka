# Sitca — Chrome Web Store listing

Everything the Developer Dashboard asks for, in the order it asks. Pictures
are beside this file: the photographs in `photos/` (1–5, marquee, tile; 1536×1024)
typeset by `demo/store-photos.mjs` — re-run it after a
change to the words or the photographs.

## Store listing

**Name:** Sitca

**Summary** (132 characters max):
Never take notes in a call again. One click records, answers your questions mid-call, writes the notes and shares a recap.

**Category:** Productivity → Communication (or "Productivity / Tools")

**Language:** English

**Description:**

Sitca sits in on your calls so you can be in the conversation — no bot joins, nothing to set up.

ONE CLICK. ANY CALL.
Open Google Meet, Zoom, Microsoft Teams, Webex, Whereby or a YouTube lecture, press the Sitca icon once, and a small card in the corner records, listens and writes while you talk.

ASK ANYTHING, WHILE IT'S HAPPENING.
Missed a name, a number, a decision? Ask Sitca mid-call — "What did Priya say about the deadline?" — and get the answer from what was actually said. Nobody else in the call sees it.

NOTES THAT WRITE THEMSELVES.
Clean notes and the key moments, with the time each one happened. Nothing to type, nothing to tidy up afterwards.

LATE? CATCH UP IN TEN SECONDS.
Join late and Sitca tells you what you missed, so you can jump straight in.

SHARE THE RECAP.
The moment the call ends you get one link: the recording, the transcript with speakers named, the notes — and an assistant that answers questions about the call. Send it to everyone who missed it.

Hosting a lecture or a meeting? Choose "Host on Sitca" and you get a link and a QR code: people in the room follow along with captions in their own language and ask Sitca privately.

Everything is saved to your Sitca account (sitcaai.vercel.app) and shared only by links you choose to send. Nothing is recorded until you press.

Sitca is free to start. Sign in with Google or an email.

## Graphic assets (in this folder)

| Asset | File | Size |
|---|---|---|
| Icon | `icon-128.png` | 128×128 |
| Screenshots (5) | `screenshot-1.png` … `screenshot-5.png` | 1280×800 |
| Small promo tile | `promo-small-440x280.png` | 440×280 |
| Marquee promo tile | `promo-marquee-1400x560.png` | 1400×560 |
| Promo video | the extension film on the site: https://sitcaai.vercel.app/sitca-extension.mp4 (upload to YouTube and paste the link) | |

Screenshot captions, in order: One click. Any call. · Ask anything, while it's happening. · Notes that write themselves. · Late? Catch up in ten seconds. · Share the recap.

## Privacy practices (the Privacy tab)

**Single purpose:** Sitca records, captions and summarises a video call or online lecture the user is attending, and answers the user's questions about it.

**Permission justifications:**
- `tabCapture` — to record the picture and sound of the call's tab when the user presses the Sitca icon. This is the recording itself.
- `activeTab` — to act on the call the user is looking at, only after they press the icon.
- `storage` — to remember the user's sign-in session, the last course chosen to save into, and the card's settings.
- `identity` — Google sign-in to the user's Sitca account.
- `tabs` — to find the call's tab again after a page change, and to open the recap in the Sitca tab.
- `offscreen` — the recording and captioning run in an offscreen document so they continue while the user switches tabs.
- `alarms` — to keep the recording engine alive during a long call and close it when idle.
- `contextMenus` — the "Capture with Sitca" item on the page's right-click menu.
- `sidePanel` — the Sitca conversation in Chrome's side panel while the call is recorded.
- Host permissions (meet.google.com, zoom.us, teams.microsoft.com, teams.live.com, teams.cloud.microsoft, webex.com, whereby.com, youtube.com) — to draw the card on those pages and read their captions; sitcaai.vercel.app and the storage hosts — to save the recording and talk to the user's account.

**Remote code:** No. All code is in the package; the extension talks to Sitca's own API over HTTPS.

**Data collected (tick these honestly):**
- Personally identifiable information: name and email (the account)
- Authentication information: the sign-in token for the user's own account
- Personal communications / audio and video: the recording and transcript of the call the user chose to capture
- Website content: the captions shown on the call page, read to build the transcript

**Data use certifications (all three, truthfully):**
- Not sold to third parties
- Not used or transferred for purposes unrelated to the item's core functionality
- Not used or transferred to determine creditworthiness or for lending

**Privacy policy URL:** https://sitcaai.vercel.app/legal

## Before pressing Publish

1. `cd web && npm run pack:ext` — makes `extension/sitca-extension.zip` from the built `extension/dist`.
2. Bump `"version"` in `extension/static/manifest.json` for every upload (the store refuses the same version twice).
3. The store shows the manifest's name, version and description; the description above goes in the dashboard, not the manifest.
4. Verified site: add sitcaai.vercel.app under the developer account so the listing shows "by sitcaai.vercel.app".
5. Review takes a few days for extensions with `tabCapture`; the justifications above are what the reviewer reads.
