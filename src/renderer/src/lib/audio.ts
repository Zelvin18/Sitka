/**
 * The container this browser can record sound in. Most write Opus in WebM;
 * iPhones and iPads write AAC in MP4 and cannot write WebM at all. An empty
 * string means: let the browser choose.
 */
export function pickAudioMimeType(): string {
  if (typeof MediaRecorder === 'undefined') return ''
  const candidates = ['audio/mp4;codecs="mp4a.40.2"', 'audio/mp4', 'audio/webm;codecs=opus', 'audio/webm']
  return candidates.find((c) => MediaRecorder.isTypeSupported(c)) ?? ''
}

/** The file extension a transcription service expects for a recorded container. */
export function audioExtension(mime: string): string {
  const m = (mime || '').toLowerCase()
  if (m.includes('mp4') || m.includes('m4a') || m.includes('aac')) return 'mp4'
  if (m.includes('ogg')) return 'ogg'
  if (m.includes('wav')) return 'wav'
  if (m.includes('mpeg') || m.includes('mp3')) return 'mp3'
  return 'webm'
}
