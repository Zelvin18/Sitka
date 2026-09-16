/**
 * Syntax colouring for the code Sitka writes: comments, strings, numbers,
 * keywords, types and function names, in the languages that come up. One
 * tokenizer, a few keyword lists, no dependency; plain text for anything it
 * does not know.
 */

export interface Token {
  kind: 'plain' | 'comment' | 'string' | 'number' | 'keyword' | 'type' | 'fn' | 'punct' | 'attr' | 'tag'
  text: string
}

const KEYWORDS: Record<string, string[]> = {
  js: 'const let var function return if else for while do switch case break continue new class extends super this import export from default async await try catch finally throw typeof instanceof in of yield static get set null undefined true false void delete'.split(' '),
  py: 'def return if elif else for while in not and or is None True False class import from as try except finally raise with lambda pass break continue yield global nonlocal assert del async await print self'.split(' '),
  go: 'package import func return if else for range var const type struct interface map chan go defer select switch case break continue default nil true false make new len append error'.split(' '),
  rs: 'fn let mut pub struct enum impl trait for in if else match return use mod crate self Some None Ok Err true false loop while const static ref as where dyn async await move'.split(' '),
  java: 'public private protected static final class interface extends implements new return if else for while do switch case break continue try catch finally throw throws void int long double float boolean char String null true false this super import package abstract'.split(' '),
  c: 'int char float double void long short unsigned signed struct union enum typedef static const extern return if else for while do switch case break continue sizeof NULL true false include define using namespace class public private protected template new delete this bool auto'.split(' '),
  sh: 'if then else elif fi for while do done in case esac function return exit echo export local'.split(' '),
  sql: 'select from where insert into values update set delete create table drop alter join left right inner outer on group by order having limit as and or not null primary key references index distinct union'.split(' '),
  css: [],
  html: []
}
const TYPES = /^[A-Z][A-Za-z0-9_]*$/

function family(lang: string): keyof typeof KEYWORDS {
  const l = lang.toLowerCase()
  if (/^(js|jsx|ts|tsx|javascript|typescript|mjs|cjs)$/.test(l)) return 'js'
  if (/^(py|python)$/.test(l)) return 'py'
  if (/^(go|golang)$/.test(l)) return 'go'
  if (/^(rs|rust)$/.test(l)) return 'rs'
  if (/^(java|kt|kotlin|cs|csharp|swift|scala)$/.test(l)) return 'java'
  if (/^(c|cpp|c\+\+|cc|h|hpp|objc)$/.test(l)) return 'c'
  if (/^(sh|bash|zsh|shell|ps1|powershell)$/.test(l)) return 'sh'
  if (/^(sql|psql|mysql)$/.test(l)) return 'sql'
  if (/^(css|scss|less)$/.test(l)) return 'css'
  if (/^(html|xml|svg|vue)$/.test(l)) return 'html'
  return 'js'
}

export function highlight(code: string, lang: string): Token[] {
  const fam = family(lang)
  const kw = new Set(KEYWORDS[fam])
  const out: Token[] = []
  const push = (kind: Token['kind'], text: string): void => {
    if (!text) return
    const last = out[out.length - 1]
    if (last && last.kind === kind && (kind === 'plain' || kind === 'punct')) last.text += text
    else out.push({ kind, text })
  }
  let i = 0
  const n = code.length
  const lineComment = fam === 'py' || fam === 'sh' ? '#' : fam === 'sql' ? '--' : '//'
  while (i < n) {
    const ch = code[i]
    const two = code.slice(i, i + 2)
    // markup: tags and attributes
    if (fam === 'html' && ch === '<') {
      const end = code.indexOf('>', i)
      const stop = end < 0 ? n : end + 1
      const tag = code.slice(i, stop)
      const m = tag.match(/^<\/?[\w:-]+/)
      if (m) {
        push('tag', m[0])
        const rest = tag.slice(m[0].length)
        const re = /([\w:-]+)(=)("[^"]*"|'[^']*')?/g
        let last = 0
        let a: RegExpExecArray | null
        while ((a = re.exec(rest))) {
          push('plain', rest.slice(last, a.index))
          push('attr', a[1])
          push('punct', a[2])
          if (a[3]) push('string', a[3])
          last = a.index + a[0].length
        }
        push('tag', rest.slice(last))
      } else push('plain', tag)
      i = stop
      continue
    }
    // comments
    if (two === '/*' && fam !== 'py' && fam !== 'sh') {
      const end = code.indexOf('*/', i + 2)
      const stop = end < 0 ? n : end + 2
      push('comment', code.slice(i, stop))
      i = stop
      continue
    }
    if (code.startsWith(lineComment, i) || (fam === 'html' && code.startsWith('<!--', i))) {
      const end = fam === 'html' && code.startsWith('<!--', i) ? code.indexOf('-->', i) + 3 : code.indexOf('\n', i)
      const stop = end <= 0 ? n : end
      push('comment', code.slice(i, stop))
      i = stop
      continue
    }
    // strings
    if (ch === '"' || ch === "'" || ch === '`') {
      let j = i + 1
      while (j < n && code[j] !== ch) {
        if (code[j] === '\\') j++
        if (ch !== '`' && code[j] === '\n') break
        j++
      }
      push('string', code.slice(i, Math.min(n, j + 1)))
      i = j + 1
      continue
    }
    // numbers
    if (/[0-9]/.test(ch) && !/[A-Za-z_]/.test(code[i - 1] ?? '')) {
      let j = i
      while (j < n && /[0-9a-fA-Fx._]/.test(code[j])) j++
      push('number', code.slice(i, j))
      i = j
      continue
    }
    // words
    if (/[A-Za-z_$@]/.test(ch)) {
      let j = i
      while (j < n && /[A-Za-z0-9_$]/.test(code[j])) j++
      const word = code.slice(i, j)
      const next = code.slice(j).match(/^\s*\(/)
      if (kw.has(word) || (fam === 'sql' && kw.has(word.toLowerCase()))) push('keyword', word)
      else if (next && !TYPES.test(word)) push('fn', word)
      else if (TYPES.test(word) && fam !== 'sh') push('type', word)
      else if (ch === '@' || (fam === 'css' && code[i - 1] === '.')) push('attr', word)
      else push('plain', word)
      i = j
      continue
    }
    if (/[{}()[\];,.:=<>+\-*/%!&|^~?]/.test(ch)) {
      push('punct', ch)
      i++
      continue
    }
    push('plain', ch)
    i++
  }
  return out
}
