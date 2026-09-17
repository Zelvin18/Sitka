"""Sitka -> Sitca, on the visible side only. Run from the repository root:

    python scripts/rename-sitca.py

Words people read change; identifiers do not. `Sitka` followed by a capital
(SitkaApi) is an identifier and stays; lowercase `sitka` (window.sitka,
sitka://, the sitka.* settings keys, the sitka_* database functions, the
sitka-recordings store, file names) stays. The old address becomes the new
one where it was typed in, and links remembered in the database under the
old address are shown under the new one as they are read. Safe to run twice.
"""
import io, os, re

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
GLOBS = [
    ('web', ('.html',)), ('web/src', ('.ts', '.tsx', '.css')), ('web/api', ('.js',)),
    ('src', ('.ts', '.tsx', '.css', '.html')), ('web/public', ('.webmanifest',)), ('scripts', ('.py',)),
]
WORD = re.compile(r'\bSitka(?![A-Z])')
changed = 0
files = 0
for base, exts in GLOBS:
    top = os.path.join(ROOT, base)
    if base == 'web':
        walk = [(top, [], [f for f in os.listdir(top) if os.path.isfile(os.path.join(top, f))])]
    else:
        walk = os.walk(top)
    for d, _dirs, names in walk:
        if 'node_modules' in d or os.sep + 'dist' in d:
            continue
        for n in names:
            if not n.endswith(exts) or n == 'rename-sitca.py':
                continue
            p = os.path.join(d, n)
            s = io.open(p, encoding='utf-8', newline='').read()
            t = WORD.sub('Sitca', s)
            t = t.replace('SITKA', 'SITCA')
            t = t.replace('sitka-blue.vercel.app', 'sitcaai.vercel.app')
            if n == 'app.html':
                t = t.replace('<a href="/">sitka.app</a>', '<a href="/">sitcaai.vercel.app</a>')
            if t != s:
                io.open(p, 'w', encoding='utf-8', newline='').write(t)
                files += 1
                changed += len(WORD.findall(s)) + s.count('SITKA') + s.count('sitka-blue.vercel.app')
print('files changed', files, '· words changed', changed)

# ---- links remembered in the database still say the old address: fixed as they are read ----
p = os.path.join(ROOT, 'web/src/webApi.ts')
s = io.open(p, encoding='utf-8', newline='').read()
if 'function freshLinks' not in s:
    old = """      for (const m of rows) if (m.sample) void api.deleteSession(m.id).catch(() => undefined)
      return rows.filter((m) => !m.sample)"""
    new = """      for (const m of rows) if (m.sample) void api.deleteSession(m.id).catch(() => undefined)
      for (const m of rows) freshLinks(m)
      return rows.filter((m) => !m.sample)"""
    assert old in s, 'listSessions anchor'
    s = s.replace(old, new, 1)
    old = """  // ---------- a session's banner: a small file with a link ----------"""
    new = """  // ---------- links written before the address changed ----------
  // A session remembers its recap link as text. Ones written under the old
  // address still open (the old address forwards), but what people see should
  // be the address they know.
  function freshLinks(meta: SessionMeta): void {
    const fix = (u?: string): string | undefined => (u && u.includes('sitka-blue.vercel.app') ? u.replace('sitka-blue.vercel.app', 'sitcaai.vercel.app') : u)
    meta.replayUrl = fix(meta.replayUrl)
    meta.recapUrl = fix(meta.recapUrl)
  }

  // ---------- a session's banner: a small file with a link ----------"""
    assert old in s, 'banner anchor'
    s = s.replace(old, new, 1)
    old = """    getSession: async (id: string) => {
      const d = await loadSession(id)"""
    new = """    getSession: async (id: string) => {
      const d = await loadSession(id)
      if (d) freshLinks(d.meta)"""
    assert old in s, 'getSession anchor'
    s = s.replace(old, new, 1)
    io.open(p, 'w', encoding='utf-8', newline='').write(s)
    print('remembered links: fixed as they are read')
else:
    print('remembered links: already handled')
