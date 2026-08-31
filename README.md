# Sitka

**Live AI intelligence for lectures, meetings, and events.**

Sitka is a desktop app where the AI attends the live session *with* you — it captures
your screen and audio, understands what is being said as it happens, answers your
questions in real time, and lets you jump straight to the exact moment anything was
discussed.

This is MVP 1: the core magic loop.

## What it does

- **Live capture** — record any screen or window, with system audio and/or microphone.
- **Live transcription** — speech becomes a timestamped transcript while the session
  is still happening (OpenAI Whisper).
- **Ask Sitka** — chat with the AI about the session, live or afterwards (Claude).
  Answers cite exact moments as clickable timestamps.
- **Jump to the moment** — click any timestamp (in the transcript, in an AI answer, or
  in the key-moments list) and the recording jumps there.
- **Auto-analysis** — when a session ends, Sitka names it, writes a summary, and picks
  out the key moments.
- **Live notes** — organized notes (topics, definitions, examples) that keep updating
  while the session runs, with ⭐ important points and ❓ detected questions.
- **Slide understanding** — during a live session, questions include a snapshot of the
  current screen, so "what does this graph mean?" actually works.
- **Student mode** — a Study tab per session: key concepts, flip flashcards, and a
  multiple-choice quiz generated from the lecture.

## Getting started

```bash
npm install
npm run dev
```

Then open **Settings** inside the app and add keys.

**Free testing path (one key):** create a free API key at console.groq.com (no card
required) and paste it into the Groq field. It powers both transcription
(Whisper large-v3-turbo) and Ask Sitka (Llama 3.3 70B).

**Best quality:**

- an **Anthropic API key** (console.anthropic.com) — Ask Sitka and summaries with
  Claude; preferred over Groq when present
- an **OpenAI API key** (platform.openai.com) — transcription; preferred over Groq
  when present

Keys are stored locally (Electron `userData/settings.json`) and are only ever sent
directly to each provider from the main process.

## Scripts

| Command | What it does |
| --- | --- |
| `npm run dev` | Run the app in development with hot reload |
| `npm run build` | Production build to `out/` |
| `npm run typecheck` | Type-check main, preload, and renderer |
| `npm run dist` | Build the installable Windows app (`release/Sitka Setup <version>.exe`) |

Recordings are post-processed with the bundled ffmpeg when a session ends (stream
copy, seconds): this writes a proper seek index so playback seeks instantly and
multi-hour recordings stream from disk instead of loading into memory. Sessions
recorded before this feature are fixed automatically the first time they are opened.

## Architecture

```
src/
  main/        Electron main process
    index.ts     window, IPC, sitka:// media protocol
    store.ts     sessions + settings on disk (userData/sessions/<id>/)
    ai.ts        Claude (ask, analysis) + Whisper (transcription)
  preload/     typed contextBridge API (window.sitka)
  renderer/    React UI
    components/  Sidebar, Home, LiveSession, SessionView, ChatPane,
                 TranscriptPane, AiText, SettingsView
  shared/      types shared across processes
```

Each session is a folder: `video.webm` (streamed to disk while recording),
`meta.json`, `transcript.json`, `chat.json`. The renderer plays recordings through the
custom `sitka://` protocol; API keys never enter the renderer process.

## Roadmap (from the product concept)

1. ✅ MVP 1 — capture → understand → ask → jump to moment
2. ✅ MVP 2 — live notes, slide understanding, important moments, questions, student mode
3. Zoom / Meet / Teams integrations, browser extension
4. QR conference companion
5. Company Brain / Conference Brain, cross-event search
