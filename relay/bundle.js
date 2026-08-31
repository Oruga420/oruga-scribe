'use strict'

/**
 * relay/bundle.js - export a recorded session as a /sop-to-video bundle.
 *
 * The video skill consumes a contract that nothing produced until now:
 *
 *   <out>/<company>/<stamp>/
 *     SOP.md          already written by synthesize()
 *     steps.json      already written by synthesize()
 *     bundle.json     here
 *     screens/
 *       step-01.webp  here, decoded from the redacted model frames
 *
 * It also closes a quiet lie. Every SOP this tool has ever written says
 * "- Screenshot: step-01.webp" under each step, and that file has never existed, so every
 * document shipped a reference to something missing. Writing the screens makes the SOP true.
 *
 * TRUST BOUNDARY. The frames arrive as base64 from the extension, which is a client. Nothing
 * here trusts a client supplied path or count: filenames are generated from the step index,
 * never from the payload, and both the count and each frame are capped.
 */

const fs = require('node:fs')
const path = require('node:path')

/** A 40 step session at ~120kb a frame is ~5mb. 200 is far past any real recording. */
const MAX_FRAMES = 200
/** A redacted model frame is capped at 1024x640 upstream, so anything this big is wrong. */
const MAX_FRAME_BYTES = 3 * 1024 * 1024

const pad = (n) => String(n).padStart(2, '0')

/**
 * Pull per-step prose out of SOP.md.
 *
 * The synthesis prompt produces a stable shape, so this is parsing a known format rather than
 * guessing at prose:
 *
 *   1. Click the "Rotate token" button in the Fake Admin Console.
 *      - Screenshot: step-01.webp
 *      - Expected result: [verify: no result was recorded in the log].
 *
 * Returns a Map of step number to { action, expected }. A step the parser cannot find simply
 * comes back absent, and the caller falls back to the recorded step name. It never invents.
 */
function parseSop(md) {
  const out = new Map()
  const text = String(md || '')
  const stepsSection = text.split(/^##\s+STEPS\s*$/m)[1]
  if (!stepsSection) return out
  const body = stepsSection.split(/^##\s+/m)[0]

  // A step starts at a line beginning with "<n>. ". Everything up to the next such line, or the
  // end, belongs to it.
  const re = /^(\d+)\.\s+(.*)$/gm
  const marks = []
  let m
  while ((m = re.exec(body)) !== null) {
    marks.push({ n: Number(m[1]), headline: m[2].trim(), at: m.index, end: re.lastIndex })
  }
  for (let i = 0; i < marks.length; i++) {
    const chunk = body.slice(marks[i].end, i + 1 < marks.length ? marks[i + 1].at : undefined)
    const expected = (chunk.match(/^\s*-\s*Expected result:\s*(.*)$/m) || [])[1] || ''
    out.set(marks[i].n, {
      action: marks[i].headline.replace(/\s+/g, ' ').trim(),
      expected: expected.replace(/\s+/g, ' ').trim(),
    })
  }
  return out
}

/**
 * Write the bundle next to the SOP.
 *
 * @param {object} args
 * @param {string} args.dir      the session output dir that already holds SOP.md
 * @param {object} args.session  the scrubbed session, as sent to synthesize
 * @param {Array<{n:number, base64:string}>} args.frames  redacted model frames only
 * @returns {{ok:boolean, bundle?:string, steps:number, missingFrames:number[], noNarration:number[], error?:string}}
 */
function writeBundle({ dir, session, frames }) {
  if (!dir || !fs.existsSync(dir)) {
    return { ok: false, steps: 0, missingFrames: [], noNarration: [], error: 'output dir does not exist: ' + dir }
  }
  const steps = Array.isArray(session && session.steps) ? session.steps : []
  if (!steps.length) {
    return { ok: false, steps: 0, missingFrames: [], noNarration: [], error: 'session has no steps' }
  }

  const list = Array.isArray(frames) ? frames : []
  if (list.length > MAX_FRAMES) {
    return { ok: false, steps: 0, missingFrames: [], noNarration: [], error: 'too many frames: ' + list.length }
  }

  let sop = ''
  try { sop = fs.readFileSync(path.join(dir, 'SOP.md'), 'utf8') } catch { /* parsed as empty */ }
  const prose = parseSop(sop)

  const screensDir = path.join(dir, 'screens')
  fs.mkdirSync(screensDir, { recursive: true })

  // Index the frames by step number. The payload never names a file: the name is derived from
  // the step index here, so a hostile or buggy client cannot steer a write.
  const byStep = new Map()
  for (const f of list) {
    const n = Number(f && f.n)
    if (!Number.isInteger(n) || n < 1) continue
    if (typeof f.base64 !== 'string' || !f.base64) continue
    byStep.set(n, f.base64)
  }

  const missingFrames = []
  const noNarration = []
  const outSteps = []

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i]
    const n = Number.isInteger(step.n) ? step.n : i + 1
    const p = prose.get(n)

    // The narration the voice reads. The SOP headline is the good source; the recorded control
    // name is the fallback, and the fallback is REPORTED rather than silently substituted,
    // because it means the document was thinner than it looks.
    let narration = p && p.action ? p.action : ''
    if (!narration) {
      narration = [step.type, step.name].filter(Boolean).join(' ').trim()
      noNarration.push(n)
    }

    const rel = 'screens/step-' + pad(n) + '.webp'
    const b64 = byStep.get(n)
    if (b64) {
      const buf = Buffer.from(b64, 'base64')
      if (!buf.length) {
        missingFrames.push(n)
      } else if (buf.length > MAX_FRAME_BYTES) {
        // Refuse rather than truncate. A frame this large is not a redacted model frame, and
        // writing a partial image would look like a working screenshot.
        missingFrames.push(n)
      } else {
        fs.writeFileSync(path.join(dir, rel), buf)
      }
    } else {
      missingFrames.push(n)
    }

    outSteps.push({
      n,
      screenshot: rel,
      action: (p && p.action) || narration,
      narration,
      expected: (p && p.expected) || '',
      signal: step.signal || null,
    })
  }

  const bundle = {
    version: 1,
    title: deriveTitle(sop, session),
    goal: String((session && session.goal) || '').trim(),
    createdAt: new Date().toISOString(),
    source: 'oruga-scribe',
    // Stated so the video skill can report it rather than discovering it as a surprise.
    missingScreenshots: missingFrames,
    stepsWithoutSopProse: noNarration,
    steps: outSteps,
  }

  const bundlePath = path.join(dir, 'bundle.json')
  fs.writeFileSync(bundlePath, JSON.stringify(bundle, null, 2), 'utf8')

  return { ok: true, bundle: bundlePath, steps: outSteps.length, missingFrames, noNarration }
}

/** The SOP's own TITLE line if it has one, otherwise the goal. Never invented. */
function deriveTitle(sop, session) {
  const m = String(sop || '').match(/^#\s*TITLE:\s*(.+)$/m)
  if (m) return m[1].trim()
  const goal = String((session && session.goal) || '').trim()
  return goal || 'Guide'
}

module.exports = { writeBundle, parseSop, MAX_FRAMES, MAX_FRAME_BYTES }
