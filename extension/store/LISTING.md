# Sitca — Chrome Web Store listing

Everything the Developer Dashboard asks for, in the order it asks. Pictures
are beside this file (made by `demo/store.mjs`; re-run it after a design change).

## Store listing

**Name:** Sitca

**Summary** (132 characters max):
The AI that sits in on your meeting: live captions, private answers and a recap link — from a small card on Meet, Zoom or Teams.

**Category:** Productivity → Communication (or "Productivity / Tools")

**Language:** English

**Description:**

Sitca sits in on your meetings, lectures and talks — without a bot joining the call.

Open a call on Google Meet, Zoom, Microsoft Teams, Webex, Whereby or a YouTube lecture, press the Sitca icon once, and a small card in the corner of the page does the rest:

• Records the call, with your microphone only if you switch it on
• Captions every word as it is said — in your language
• Answers your questions privately, from what has actually been said ("What did she just say?", "Summarise the last ten minutes", "What was the deadline?"). Nobody in the call sees this.
• Writes notes and picks out the key moments as it goes
• Hands you a recap link the moment the call ends: recording, transcript with the speakers named, notes and highlights. Send it to everyone who missed it — they can ask it questions too.

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

Screenshot captions, in order: one press to capture · live captions · ask privately · a recap link when it ends · nothing is recorded until you press.

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
