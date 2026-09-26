// The whole check, as many times as asked, with the results written down.
//
//   node tests/run.mjs                 once
//   node tests/run.mjs --times 3       three times in a row (what a set needs)
//   node tests/run.mjs --label "Set 1" --times 3
//
// Each run: the web app's types, the server routes' types, the app screens' types, every test suite
// (API routes, database rules, the recording engine, shared logic), the web
// build and the extension build (into a folder of its own). A run passes
// only when every stage passes. Results go to tests/RESULTS.md.

import { spawnSync } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const web = join(root, 'web')
const args = process.argv.slice(2)
const times = Math.max(1, Number(args[args.indexOf('--times') + 1]) || 1)
const label = args.includes('--label') ? args[args.indexOf('--label') + 1] : ''
const quick = args.includes('--quick') // skip the two builds (for iterating)

const env = { ...process.env, NODE_OPTIONS: '--max-old-space-size=2048' }
const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx'

function run(name, cmd, argv, cwd, extraEnv = {}) {
  const t0 = Date.now()
  // npx is a script on Windows and needs the shell; node itself must not go through it (its path has a space)
  const r = spawnSync(cmd, argv, { cwd, env: { ...env, ...extraEnv }, encoding: 'utf8', shell: process.platform === 'win32' && cmd === npx, maxBuffer: 64 * 1024 * 1024 })
  const out = `${r.stdout || ''}${r.stderr || ''}`
  const ok = r.status === 0
  const secs = ((Date.now() - t0) / 1000).toFixed(1)
  let detail = ''
  const m = /# tests (\d+)[\s\S]*?# pass (\d+)[\s\S]*?# fail (\d+)/.exec(out)
  if (m) detail = `${m[2]}/${m[1]} passed`
  if (!ok) {
    const failing = out
      .split('\n')
      .filter((l) => /^not ok|error TS|Error:|✗|failed/i.test(l))
      .slice(0, 12)
      .join('\n')
    detail += (detail ? ' · ' : '') + (failing || out.slice(-800))
  }
  return { name, ok, secs, detail }
}

const suites = readdirSync(join(here, 'suites'))
  .filter((f) => f.endsWith('.test.mjs'))
  .map((f) => `suites/${f}`)

const results = []
for (let i = 1; i <= times; i++) {
  const stages = []
  stages.push(run('web types', npx, ['tsc', '--noEmit', '-p', 'tsconfig.json'], web))
  stages.push(run('server types', npx, ['tsc', '--noEmit', '-p', 'tsconfig.api.json'], web))
  stages.push(run('app types', npx, ['tsc', '--noEmit', '-p', 'tsconfig.web.json'], root))
  stages.push(run('test suites', process.execPath, ['--test', '--test-concurrency=1', '--import', 'tsx', ...suites], here))
  if (!quick) {
    stages.push(run('web build', npx, ['vite', 'build', '--outDir', join(tmpdir(), 'sitca-test-web'), '--emptyOutDir'], web))
    const extOut = join(tmpdir(), 'sitca-test-ext')
    if (existsSync(extOut)) rmSync(extOut, { recursive: true, force: true })
    mkdirSync(extOut, { recursive: true })
    stages.push(run('extension build', npx, ['vite', 'build', '-c', 'vite.ext.config.ts'], web, { SITCA_EXT_OUT: extOut }))
  }
  const ok = stages.every((s) => s.ok)
  results.push({ i, ok, stages })
  console.log(`\nRun ${i} of ${times}: ${ok ? 'PASS' : 'FAIL'}`)
  for (const s of stages) console.log(`  ${s.ok ? 'ok  ' : 'FAIL'} ${s.name.padEnd(16)} ${s.secs.padStart(6)} s  ${s.detail.split('\n')[0]}`)
  for (const s of stages.filter((x) => !x.ok)) console.log(`\n--- ${s.name} ---\n${s.detail}\n`)
}

const allOk = results.every((r) => r.ok)
const stamp = new Date().toISOString().replace('T', ' ').slice(0, 16)
const commit = spawnSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: root, encoding: 'utf8' }).stdout.trim()
const dirty = spawnSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).stdout.trim() ? ' (with uncommitted changes)' : ''
const lines = [
  `## ${stamp} UTC · ${label || 'check'} · ${allOk ? 'PASS' : 'FAIL'} ${times}× · commit ${commit}${dirty}`,
  '',
  '| Run | ' + results[0].stages.map((s) => s.name).join(' | ') + ' |',
  '|---|' + results[0].stages.map(() => '---').join('|') + '|',
  ...results.map((r) => `| ${r.i} | ` + r.stages.map((s) => `${s.ok ? '✓' : '✗'} ${s.detail.split('\n')[0].slice(0, 40) || s.secs + ' s'}`).join(' | ') + ' |'),
  '',
  ''
]
const file = join(here, 'RESULTS.md')
if (!existsSync(file)) writeFileSync(file, '# Test results\n\nEvery run of `node tests/run.mjs`, newest last.\n\n')
appendFileSync(file, lines.join('\n'))
console.log(`\n${allOk ? 'ALL PASS' : 'SOMETHING FAILED'} (${times}×) — written to tests/RESULTS.md`)
process.exit(allOk ? 0 : 1)
