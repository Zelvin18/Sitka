/**
 * The clock references Sitka's writing carries — [[12:34]], (0:15), "at
 * 12:34" — removed. On screen a moment cites its second so it can be jumped
 * to; in a file that is sent to someone, a time means nothing.
 */
export function withoutTimes(md: string): string {
  return md
    .replace(/\[\[(?:[a-fA-F0-9-]{6,}@)?\d{1,2}:\d{2}(?::\d{2})?\]\]/g, '')
    .replace(/\[\d{1,2}:\d{2}(?::\d{2})?\]/g, '')
    .replace(/\((?:at |around |from )?\d{1,2}:\d{2}(?::\d{2})?(?:\s*[-–]\s*\d{1,2}:\d{2}(?::\d{2})?)?\)/g, '')
    .replace(/\b(?:at|around|from|by)\s+\d{1,2}:\d{2}(?::\d{2})?(?!\s*(?:am|pm|AM|PM))\b/g, '')
    .replace(/^\s*\d{1,2}:\d{2}(?::\d{2})?\s*[—–-]\s*/gm, '')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/ ([,.;:])/g, '$1')
    .replace(/\( *\)/g, '')
}
