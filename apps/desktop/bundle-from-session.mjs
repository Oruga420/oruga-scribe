/**
 * apps/desktop/bundle-from-session.mjs
 *
 * Turns a desktop recording into the bundle that /sop-to-video consumes.
 *
 *   node apps/desktop/bundle-from-session.mjs <session-dir>
 *   node apps/desktop/bundle-from-session.mjs            # newest session under out/
 *
 * The browser front end already has a bundler, relay/bundle.js, but it takes frames as base64
 * from the extension over HTTP. The desktop app writes real PNGs to disk, so this is the bridge
 * for that half. It IMPORTS relay/bundle.js's parseSop rather than reimplementing it: the SOP
 * shape is one contract and this repo has already paid for keeping two copies of one contract.
 *
 * It also fixes a lie the shared prompt introduces. relay/prompts/sop-system.txt tells the model
 * to write "- Screenshot: step-01.webp" under each step, because that is what the browser front
 * end produces. The desktop app produces step-001.png. Left alone, every desktop SOP references
 * files that do not exist and the video finds no images at all. Rewriting the references is what
 * makes the document true, and it is done from the files ON DISK, never from what the model said.
 */

import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..', '..')
const { parseSop } = require(path.join(ROOT, 'relay', 'bundle.js'))

function newestSession() {
  const outDir = path.join(ROOT, 'out')
  if (!fs.existsSync(outDir)) throw new Error('No out\\ directory yet. Record something first.')
  const sessions = fs.readdirSync(outDir)
    .filter((d) => d.startsWith('session-'))
    .filter((d) => fs.existsSync(path.join(outDir, d, 'steps.jsonl')))
    .sort()
  if (!sessions.length) throw new Error('No recorded sessions under out\\.')
  return path.join(outDir, sessions[sessions.length - 1])
}

function readSteps(dir) {
  const raw = fs.readFileSync(path.join(dir, 'steps.jsonl'), 'utf8').trim()
  if (!raw) throw new Error('steps.jsonl is empty: nothing was recorded.')
  return raw.split('\n').map((line, i) => {
    try { return JSON.parse(line) } catch { throw new Error('steps.jsonl line ' + (i + 1) + ' is not valid JSON.') }
  })
}

/**
 * The narration the voice reads, and the honest fallback when the SOP has no prose for a step.
 *
 * A tier 1 step has no control name by design: the accessibility tree did not answer, and the
 * recorder refuses to invent one. Saying "click in <window>" is thin but TRUE, which is the
 * whole contract. The count of these is reported in the bundle so the video skill can say so
 * rather than discovering it as a surprise halfway through a render.
 */
function fallbackNarration(step) {
  if (step.control) return 'Click ' + step.control
  const where = step.window || step.process || 'the application'
  return 'Click at (' + step.x + ', ' + step.y + ') in ' + where
}

function build(sessionDir) {
  const steps = readSteps(sessionDir)
  const screensDir = path.join(sessionDir, 'screens')

  let sop = ''
  const sopPath = path.join(sessionDir, 'SOP.md')
  if (fs.existsSync(sopPath)) sop = fs.readFileSync(sopPath, 'utf8')
  else console.log('  note: no SOP.md in this session, narration falls back to the recorded steps')

  const prose = parseSop(sop)

  const goal = fs.existsSync(path.join(sessionDir, 'goal.txt'))
    ? fs.readFileSync(path.join(sessionDir, 'goal.txt'), 'utf8').trim()
    : ''

  const missingScreenshots = []
  const stepsWithoutSopProse = []
  const outSteps = []

  for (const step of steps) {
    const n = Number(step.i)
    // The filename is derived from the step index here, never taken from the step payload.
    const file = 'step-' + String(n).padStart(3, '0') + '.png'
    const rel = 'screens/' + file
    const exists = fs.existsSync(path.join(screensDir, file))
    if (!exists) missingScreenshots.push(n)

    const p = prose.get(n)
    let narration = p && p.action ? p.action : ''
    if (!narration) {
      narration = fallbackNarration(step)
      stepsWithoutSopProse.push(n)
    }

    outSteps.push({
      n,
      screenshot: exists ? rel : null,
      action: narration,
      expected: (p && p.expected) || '',
      // Carried so the video can mark a degraded step instead of pretending it is like the rest.
      tier: step.tier,
      degraded: step.tier !== '2',
      redacted: step.secure !== 'NotSecure',
    })
  }

  const title = (sop.match(/^#\s*(?:TITLE:\s*)?(.+)$/m) || [])[1] || goal || 'Guide'

  const bundle = {
    version: 1,
    title: title.trim(),
    goal,
    // Stamped by the caller's clock on purpose: this script is the only thing that knows when
    // the bundle was built, as opposed to when the recording happened.
    createdAt: new Date().toISOString(),
    source: 'oruga-scribe-desktop',
    missingScreenshots,
    stepsWithoutSopProse,
    steps: outSteps,
  }

  fs.writeFileSync(path.join(sessionDir, 'bundle.json'), JSON.stringify(bundle, null, 2), 'utf8')

  // Make the SOP true. Rewrite every "step-NN.webp" reference to the file that actually exists.
  let rewrites = 0
  if (sop) {
    const fixed = sop.replace(/step-(\d+)\.(webp|png)/g, (m, digits) => {
      const n = Number(digits)
      const real = 'step-' + String(n).padStart(3, '0') + '.png'
      if (m !== real) rewrites++
      return real
    })
    if (fixed !== sop) fs.writeFileSync(sopPath, fixed, 'utf8')
  }

  return { bundle, rewrites, sessionDir }
}

const arg = process.argv[2]
const dir = arg ? path.resolve(arg) : newestSession()
if (!fs.existsSync(dir)) {
  console.error('  no such session: ' + dir)
  process.exit(1)
}

try {
  const { bundle, rewrites } = build(dir)
  console.log('')
  console.log('  bundle written   ' + path.join(dir, 'bundle.json'))
  console.log('  title            ' + bundle.title)
  console.log('  steps            ' + bundle.steps.length)
  console.log('  degraded         ' + bundle.steps.filter((s) => s.degraded).length +
              '   (no control name, the accessibility tree did not answer)')
  console.log('  redacted         ' + bundle.steps.filter((s) => s.redacted).length +
              '   (secure or unknown field, label withheld)')
  console.log('  missing screens  ' + (bundle.missingScreenshots.length || 'none'))
  console.log('  no SOP prose     ' + (bundle.stepsWithoutSopProse.length || 'none') +
              '   (narration fell back to the recorded step)')
  console.log('  SOP refs fixed   ' + rewrites)
  console.log('')
} catch (err) {
  console.error('  ' + err.message)
  process.exit(1)
}
