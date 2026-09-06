import type { TranscriptSegment } from './types'

/**
 * The built-in sample lecture: a short, original talk on how memory forms.
 * It lets a brand-new user see Sitka work — transcript, answers, notes,
 * study pack — before they have recorded anything of their own.
 */
export const SAMPLE_TITLE = 'Why we forget, and how memory actually forms'

const LINES: [number, string][] = [
  [0, "Good morning everyone. Today I want to talk about something you all do constantly and almost never think about: forgetting."],
  [7, 'Most people assume forgetting is a failure of the brain. It is not. Forgetting is a feature. The brain is aggressively deciding what is worth keeping.'],
  [16, "So the real question for anyone who studies, or attends meetings, or sits in rooms like this one, is: how do you tell your brain that something is worth keeping?"],
  [25, "Let's start with the forgetting curve. In the 1880s, Hermann Ebbinghaus memorised lists of nonsense syllables and tested himself over days."],
  [34, 'He found that recall drops steeply within the first day, and then the decline flattens out. Most of what you lose, you lose fast.'],
  [42, "Now here is the part that matters. Every time you successfully recall something, the curve resets, and the next decline is slower than the last one."],
  [51, 'That is the spacing effect. Reviewing something four times spread across two weeks beats reviewing it four times in one evening, even though the total effort is identical.'],
  [61, "The second idea is retrieval practice. Re-reading your notes feels productive because the material looks familiar. Familiarity is not memory."],
  [70, 'Pulling the answer out of your own head, without looking, is what strengthens the trace. Testing yourself is not a way to measure learning. It is the learning.'],
  [80, 'Third: sleep. During deep sleep the hippocampus replays the day to the cortex, and that replay is when short-term traces are consolidated into long-term structure.'],
  [90, 'So an all-nighter before an exam is a way of memorising things and then throwing away the machinery that would have kept them.'],
  [98, "Let me give you the practical version, because I promised you something you can use tomorrow."],
  [104, 'One: within a day of hearing something, write down the three things that mattered, from memory, before you look at any notes.'],
  [113, 'Two: come back to those three things after a few days, then after a couple of weeks. Short visits, spaced out.'],
  [121, 'Three: explain the idea to someone else in your own words. If you cannot explain it simply, you have recognition, not understanding.'],
  [130, 'And four: protect your sleep on the nights that follow important days. That is when the filing happens.'],
  [138, "One more thing before questions. People ask me whether writing things down means you don't need to remember them."],
  [146, 'My view is that capturing something is the first step, not the last. A record you never revisit is just a very slow way to forget.'],
  [155, "The value is in the return trip: asking the record a question, days later, and finding the exact moment that answers it."],
  [164, "That is what a good memory does, and it is what a good tool for memory should do too. Thank you. Let's take questions."]
]

export function sampleSegments(): TranscriptSegment[] {
  return LINES.map(([start, text], i) => ({
    start,
    end: i + 1 < LINES.length ? LINES[i + 1][0] : start + 8,
    text
  }))
}

export function sampleDurationMs(): number {
  const segs = sampleSegments()
  return (segs[segs.length - 1]?.end ?? 0) * 1000
}
