import type { SupabaseClient } from '@supabase/supabase-js'

/**
 * A shared recap, read by its id: anyone with the link may read the recap it
 * names, and nobody may list the others (supabase/recap-privacy.sql).
 * sitka_recap answers for one recap that is on, or null. Until that script
 * has run, the table is read as it was.
 */
export async function readRecap<T>(sb: SupabaseClient, id: string): Promise<T | null> {
  const { data, error } = await sb.rpc('sitka_recap', { p_id: id })
  if (!error) return (data as T | null) ?? null
  const missing = error.code === 'PGRST202' || /could not find the function/i.test(error.message)
  if (!missing) return null
  const old = await sb.from('recaps').select('*').eq('id', id).eq('enabled', true).maybeSingle()
  return (old.data as T | null) ?? null
}
