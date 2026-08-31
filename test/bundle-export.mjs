/**
 * test/bundle-export.mjs - POST /bundle, driven against a REAL recorded session.
 *
 * The bundle route writes files to a path that arrives in a request body, using image bytes that
 * also arrive in a request body. Both of those are client supplied, so this test is mostly about
 * proving the refusals happen rather than proving the happy path works.
 *
 * It runs on SCRIBE_PORT=8799. The relay Alejandro keeps on 8787 is never touched: holding that
 * port has already broken his start-relay.bat twice.
 *
 *   node test/bundle-export.mjs
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const DIR = path.join(ROOT, 'out/personal/2026-08-24-18-44-51')
const PORT = 8799
const BASE = 'http://127.0.0.1:' + PORT

/** A real 1x1 webp, so what lands on disk is a decodable image and not just bytes. */
const WEBP = 'UklGRhoAAABXRUJQVlA4TA0AAAAvAAAAEAcQERGIiP4HAA=='

if (!fs.existsSync(path.join(DIR, 'SOP.md'))) {
  console.error('  SKIP: no recorded session at ' + DIR)
  console.error('  This test reads a real SOP.md so the parser runs against real synthesis output.')
  process.exit(0)
}

// Start clean, or a previous run's screens make the "one per step" count pass by accident.
fs.rmSync(path.join(DIR, 'screens'), { recursive: true, force: true })
fs.rmSync(path.join(DIR, 'bundle.json'), { force: true })

const steps = JSON.parse(fs.readFileSync(path.join(DIR, 'steps.json'), 'utf8'))
const list = Array.isArray(steps) ? steps : steps.steps

const relay = spawn(process.execPath, [path.join(ROOT, 'relay/server.js')], {
  env: { ...process.env, SCRIBE_PORT: String(PORT) },
  cwd: ROOT,
  stdio: ['ignore', 'pipe', 'pipe'],
})
let relayLog = ''
relay.stdout.on('data', (d) => { relayLog += d })
relay.stderr.on('data', (d) => { relayLog += d })

const post = async (body) => {
  const r = await fetch(BASE + '/bundle', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  return { status: r.status, body: await r.json() }
}

let fails = 0
const check = (name, cond, detail) => {
  console.log((cond ? '  PASS  ' : '  FAIL  ') + name + (detail ? '   ' + detail : ''))
  if (!cond) fails++
}

async function main() {
  for (let i = 0; i < 60; i++) {
    try { const r = await fetch(BASE + '/health'); if (r.ok) break } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 250))
  }

  const session = { goal: 'how to rotate a project token', company: 'personal', steps: list }

  // --- the refusals ---------------------------------------------------------

  let r = await post({ dir: 'C:/Windows/Temp', session, frames: [] })
  check('a path outside out/ is refused', r.status === 400 && /inside out/.test(r.body.error), r.body.error)

  r = await post({ dir: path.join(ROOT, 'out/personal/../../relay'), session, frames: [] })
  check('a dot dot escape is refused', r.status === 400, r.body.error)

  r = await post({ dir: path.join(ROOT, 'out/personal/does-not-exist'), session, frames: [] })
  check('a nonexistent dir is refused', r.status === 400 && /does not exist/.test(r.body.error), r.body.error)

  r = await post({ dir: DIR, session: { steps: [] }, frames: [] })
  check('a session with no steps is refused', r.status === 400, r.body.error)

  r = await post({ dir: DIR, session, frames: Array.from({ length: 201 }, (_, i) => ({ n: i + 1, base64: WEBP })) })
  check('more than MAX_FRAMES is refused', r.body.ok === false && /too many/.test(r.body.error), r.body.error)

  // An oversized frame is REFUSED rather than truncated. A half written image looks like a
  // working screenshot, which is the exact failure mode this repo keeps producing.
  const huge = Buffer.alloc(4 * 1024 * 1024, 1).toString('base64')
  r = await post({ dir: DIR, session, frames: [{ n: 1, base64: huge }] })
  check('an oversized frame is reported missing', r.body.ok === true && r.body.missingFrames.includes(1),
    JSON.stringify(r.body.missingFrames))
  check('an oversized frame writes no file', !fs.existsSync(path.join(DIR, 'screens/step-01.webp')))

  // --- the real export ------------------------------------------------------

  r = await post({ dir: DIR, session, frames: list.map((s) => ({ n: s.n, base64: WEBP })) })
  check('the bundle is written', r.body.ok === true, r.body.error || '')
  check('every step is in it', r.body.steps === list.length, r.body.steps + ' of ' + list.length)
  check('no frame is missing', r.body.missingFrames.length === 0, JSON.stringify(r.body.missingFrames))
  check('no step fell back off the SOP', r.body.noNarration.length === 0, JSON.stringify(r.body.noNarration))

  const b = JSON.parse(fs.readFileSync(path.join(DIR, 'bundle.json'), 'utf8'))
  check('the title came from the SOP, not the fallback', b.title && b.title !== 'Guide', b.title)
  check('narration was parsed out of the SOP prose', /Rotate token/.test(b.steps[0].narration), b.steps[0].narration)
  check('the verify marker survived into expected', /\[verify:/.test(b.steps[0].expected), b.steps[0].expected)
  check('the screenshot path is derived from the index', b.steps[0].screenshot === 'screens/step-01.webp',
    b.steps[0].screenshot)

  const img = fs.readFileSync(path.join(DIR, 'screens/step-01.webp'))
  check('step-01.webp finally exists', img.length > 0, img.length + ' bytes')
  check('and it is a real RIFF/WEBP', img.slice(0, 4).toString() === 'RIFF' && img.slice(8, 12).toString() === 'WEBP')

  const written = fs.readdirSync(path.join(DIR, 'screens')).sort()
  check('one screen per step', written.length === list.length, written.join(' '))

  // The SOP has been promising these filenames since the first recording. Prove the promise now
  // resolves, for every step, rather than for the one that happens to be first.
  //
  // Two forms are accepted on purpose. SOPs synthesized before 2026-08-25 say "step-01.webp",
  // which is wrong relative to SOP.md and is why the prompt now dictates "screens/step-01.webp".
  // Old recordings on disk keep the old text, so resolving both is what lets this test run
  // against a real artifact instead of one regenerated to suit it.
  const promised = (fs.readFileSync(path.join(DIR, 'SOP.md'), 'utf8').match(/Screenshot:\s*(\S+)/g) || [])
    .map((s) => s.replace(/Screenshot:\s*/, ''))
  const unresolved = promised.filter((f) =>
    !fs.existsSync(path.join(DIR, f)) && !fs.existsSync(path.join(DIR, 'screens', path.basename(f))))
  check('every filename the SOP references now resolves', unresolved.length === 0, unresolved.join(' '))

  // A filename in the payload must not steer the write.
  r = await post({
    dir: DIR,
    session,
    frames: [{ n: 1, base64: WEBP, name: '../../../evil.webp', screenshot: '../../evil.webp' }],
  })
  check('a filename in the payload is ignored',
    r.body.ok === true && !fs.existsSync(path.join(ROOT, 'evil.webp')) && !fs.existsSync(path.join(ROOT, 'out/evil.webp')))

  console.log('\n  ' + (fails ? fails + ' FAILED' : 'all green'))
  if (relayLog.trim()) {
    console.log('\n  the relay said:\n' + relayLog.trimEnd().split('\n').map((l) => '    ' + l).join('\n'))
  }
  relay.kill()
  process.exitCode = fails ? 1 : 0
}

main().catch((e) => { console.error(e); relay.kill(); process.exitCode = 1 })
