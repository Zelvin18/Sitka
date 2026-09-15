-- Sitka wave 14: a shared link carries the session's title and picture.
-- Run AFTER the previous scripts. Safe to run more than once.
--
-- WhatsApp, iMessage, Slack and the rest fetch a link before showing it, and
-- read the page's title and preview image from the HTML itself, with no code
-- running. The recap page is now served by a small function that writes the
-- session's title and a frame of its recording into that HTML. The frame
-- comes from here: the same small picture the library shows on its cards,
-- copied onto the recap when it is shared.

alter table public.recaps add column if not exists thumb text;
