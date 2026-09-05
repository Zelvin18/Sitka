/**
 * Desktop memory store: decisions, promises, people and concepts kept across
 * sessions in userData/memory.json, extracted after each session's analysis.
 */
import { app } from 'electron'
import { existsSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { randomUUID } from 'crypto'
import type { MemoryObject, SessionMeta, TranscriptSegment } from '@shared/types'
import {
  memorySystemPrompt,
  memoryTranscript,
  mergeMemory,
  type MemoryExtraction
} from '@shared/memoryLogic'
import { completeText, extractJson, type AiKeys } from './ai'

const memoryPath = (): string => join(app.getPath('userData'), 'memory.json')

export function loadMemory(): MemoryObject[] {
  try {
    if (!existsSync(memoryPath())) return []
    return JSON.parse(readFileSync(memoryPath(), 'utf8')) as MemoryObject[]
  } catch {
    return []
  }
}

export function saveMemory(list: MemoryObject[]): void {
  writeFileSync(memoryPath(), JSON.stringify(list, null, 2), 'utf8')
}

export function updateMemoryObject(
  id: string,
  patch: { status?: 'open' | 'changed' | 'done' }
): MemoryObject | null {
  const list = loadMemory()
  const obj = list.find((o) => o.id === id)
  if (!obj) return null
  if (patch.status) obj.status = patch.status
  obj.updatedAt = Date.now()
  saveMemory(list)
  return obj
}

export function deleteMemoryObject(id: string): void {
  saveMemory(loadMemory().filter((o) => o.id !== id))
}

/** After a session ends: remember its durable facts (best-effort). */
export async function rememberSession(
  keys: AiKeys,
  meta: SessionMeta,
  segments: TranscriptSegment[]
): Promise<void> {
  if (segments.length < 6) return
  const existing = loadMemory()
  const today = new Date().toISOString().slice(0, 10)
  const out = await completeText(
    keys,
    memorySystemPrompt(meta.kind, existing, today),
    memoryTranscript(segments)
  )
  const parsed = extractJson<MemoryExtraction>(out)
  if (!parsed) return
  saveMemory(mergeMemory(existing, parsed, { id: meta.id, title: meta.title }, randomUUID))
}
