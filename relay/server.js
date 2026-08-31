'use strict'

/**
 * relay/server.js - localhost bridge between the extension and Claude.
 *
 * Zero dependencies on purpose: node:http is enough, and a relay that holds no secrets
 * and installs no packages is one less thing to audit.
 *
 * Binds 127.0.0.1 only. Origin is checked against chrome-extension:// so a random page
 * cannot drive it.
 */

const http = require('node:http')
const fs = require('node:fs')
const path = require('node:path')
const C = require('./claude')
const scrub = require('./scrub')
const bundle = require('./bundle')

const PORT = Number(process.env.SCRIBE_PORT || 8787)
const HOST = '127.0.0.1'
const OUT_DIR = path.join(__dirname, '..', 'out')
const MAX_BODY = 32 * 1024 * 1024   // a 40 step session with base64 frames

/**
 * The user blocklist: literal strings and regexes that must never leave the machine, applied
 * LAST in the scrubber so they win over everything else.
 *
 * This was dead code: scrub.setBlocklist existed and nothing ever called it, so the feature the
 * design promised did not exist. Now it loads from relay/blocklist.json at boot.
 *
 * Format: ["some literal string", {"pattern": "acme-\\d+", "flags": "gi", "to": "[CLIENT]"}]
 */
function loadBlocklist() {
  const file = path.join(__dirname, 'blocklist.json')
  if (!fs.existsSync(file)) return 0
  try {
    const list = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (!Array.isArray(list)) throw new Error('blocklist.json must contain an array')
    scrub.setBlocklist(list)
    return list.length
  } catch (e) {
    // Fail loudly and keep the built in patterns rather than starting with a silently
    // broken blocklist the user believes is protecting them.
    console.error('\n  BLOCKLIST NOT LOADED: ' + e.message)
    console.error('  Built in redaction still applies, but your custom entries do NOT.\n')
    return -1
  }
}

// Narration must never run two spawns at once FOR THE SAME SESSION: overlapping calls stack
// Node processes and the panel falls progressively behind. Single flight, with newly arrived
// steps merged into the next payload instead of queued as another call.
//
// KEYED BY SESSION. This was two module globals, which is correct for exactly one user and
// a cross tenant leak for any more than that: user B's steps went into the shared merge
// buffer and were drained into user A's in flight call, so B's page titles, URLs and click
// labels landed in A's document while B got only "202 merged" and never saw his own
// narration. Both returned 200. Nothing logged.
//
// A Map keyed by session id fixes it, and steps are NEVER merged across session ids.
const flights = new Map() // sessionId -> { inFlight: Promise|null, mergeBuffer: [] }

function flightFor(sessionId) {
  let f = flights.get(sessionId)
  if (!f) {
    f = { inFlight: null, mergeBuffer: [] }
    flights.set(sessionId, f)
  }
  return f
}

/** Drop the entry once a session is quiet, so the Map does not grow for the process lifetime. */
function releaseFlight(sessionId) {
  const f = flights.get(sessionId)
  if (f && !f.inFlight && !f.mergeBuffer.length) flights.delete(sessionId)
}

const server = http.createServer(async (req, res) => {
  const origin = req.headers.origin || ''
  const allowed = !origin || origin.startsWith('chrome-extension://')

  res.setHeader('Access-Control-Allow-Origin', allowed ? (origin || '*') : 'null')
  res.setHeader('Access-Control-Allow-Headers', 'content-type')
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS')
  res.setHeader('Vary', 'Origin')

  if (req.method === 'OPTIONS') return end(res, 204, '')
  if (!allowed) return json(res, 403, { ok: false, error: 'origin not allowed: ' + origin })

  // `return await`, not `return`. Returning a promise from inside try/catch resolves it
  // OUTSIDE the try, so a rejected route became an unhandled rejection and Node killed the
  // whole relay. From the extension that looked like "Failed to fetch" with no explanation.
  try {
    if (req.url === '/health') return await health(res)
    if (req.url === '/narrate' && req.method === 'POST') return await narrate(req, res)
    if (req.url === '/synthesize' && req.method === 'POST') return await synthesize(req, res)
    if (req.url === '/bundle' && req.method === 'POST') return await bundleRoute(req, res)
    if (req.url === '/preview' && req.method === 'POST') return await preview(req, res)
    return json(res, 404, { ok: false, error: 'no such route' })
  } catch (e) {
    console.error('  route error on ' + req.url + ': ' + (e && e.stack || e))
    return json(res, 500, { ok: false, error: String(e && e.message || e) })
  }
})

/**
 * A relay that dies takes the recording session's narration with it and shows up in the panel
 * as an unexplained "Failed to fetch". Log loudly, stay alive.
 */
process.on('unhandledRejection', (e) => {
  console.error('\n  UNHANDLED REJECTION (relay staying up): ' + (e && e.stack || e) + '\n')
})
// This handler exists because of bug 8: an error thrown inside a route killed Node and the
// extension saw only "Failed to fetch". Surviving an in flight route error is correct.
//
// But it must not claim to be surviving when it is not. A failure BEFORE the server is
// listening (EADDRINUSE is the common one) is fatal: nothing bound, so there is nothing to
// stay up, and the process exits regardless. Printing "relay staying up" there is a message
// that contradicts what actually happens one line later, which is exactly the class of
// silent-lie failure this project keeps finding in itself.
let listening = false

process.on('uncaughtException', (e) => {
  if (!listening) {
    console.error('\n  FATAL, the relay never started: ' + (e && e.message || e) + '\n')
    process.exit(1)
  }
  console.error('\n  UNCAUGHT EXCEPTION (relay staying up): ' + (e && e.stack || e) + '\n')
})

// --- routes -----------------------------------------------------------------

function health(res) {
  let loggedIn = false
  let exe = null
  let detail = ''
  try {
    exe = C.resolveExe()
    loggedIn = C.isLoggedIn()
  } catch (e) {
    detail = e.message
  }
  json(res, 200, {
    ok: true,
    loggedIn,
    exe: exe ? path.basename(exe) : null,
    configDir: C.configDir(),
    detail,
    hint: loggedIn ? '' :
      'Run this once from the repo root and /login with your personal account:\n' +
      '  CLAUDE_CONFIG_DIR="$PWD/relay/.claude-home" claude auth login',
  })
}

function hasOauth(file) {
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8'))
    return !!(j.oauthAccount || j.primaryApiKey || j.hasCompletedOnboarding)
  } catch { return false }
}

/**
 * Narrate a group of one to three settled steps.
 * Body: { goal, company, steps: [...], image?: {base64, mediaType} }
 */
async function narrate(req, res) {
  const body = await readJson(req)
  if (!body || !Array.isArray(body.steps) || !body.steps.length) {
    return json(res, 400, { ok: false, error: 'steps required' })
  }

  // Fail closed on a missing session id rather than falling back to a shared bucket. A
  // default key would silently restore the exact cross tenant merge this keying exists to
  // prevent, and it would look like it was working.
  const sessionId = typeof body.sessionId === 'string' && body.sessionId.trim()
  if (!sessionId) {
    return json(res, 400, {
      ok: false,
      error: 'sessionId required: narration state is keyed per session so steps are never ' +
        'merged across recordings',
    })
  }

  const flight = flightFor(sessionId)

  if (flight.inFlight) {
    // Merge rather than queue, but only within this session. The panel gets one narration
    // covering both groups. Capped: an unbounded buffer would grow all session and then be
    // sent as one enormous prompt, which is both slow and useless. Keep the most recent.
    const MAX_MERGE = 12
    flight.mergeBuffer.push(...body.steps)
    let dropped = 0
    if (flight.mergeBuffer.length > MAX_MERGE) {
      dropped = flight.mergeBuffer.length - MAX_MERGE
      flight.mergeBuffer = flight.mergeBuffer.slice(-MAX_MERGE)
      console.error('  narration is falling behind for ' + sessionId +
        ': dropped ' + dropped + ' step(s) from the merge buffer')
    }
    return json(res, 202, {
      ok: true, merged: true, sessionId,
      pending: flight.mergeBuffer.length, dropped,
    })
  }

  const steps = body.steps.concat(flight.mergeBuffer.splice(0))

  let clean
  try {
    clean = scrub.scrubPayload({ goal: body.goal, company: body.company, steps })
  } catch (e) {
    // Fail closed. A scrubber that throws means we do not know what is in the payload.
    return json(res, 200, { ok: false, dropped: true, error: 'redaction failed, step dropped: ' + e.message })
  }

  const image = body.image && body.image.base64
    ? { base64: body.image.base64, mediaType: body.image.mediaType || 'image/webp' }
    : null

  const payload = C.buildUserMessage(scrub.renderNarrationPrompt(clean), image)

  res.writeHead(200, {
    'content-type': 'application/x-ndjson; charset=utf-8',
    'cache-control': 'no-store',
  })

  // Writing to a socket the client already dropped throws. The panel closes when the side panel
  // closes or the extension reloads, which happens mid narration all the time.
  const send = (obj) => {
    if (res.writableEnded || res.destroyed) return false
    try { return res.write(JSON.stringify(obj) + '\n') } catch { return false }
  }

  // If the client goes away, stop the model call too. Otherwise a closed panel keeps burning
  // quota generating narration nobody will ever read.
  const abort = new AbortController()
  const onClientGone = () => abort.abort()
  req.on('aborted', onClientGone)
  res.on('close', () => { if (!res.writableEnded) onClientGone() })

  flight.inFlight = C.run('narrate', payload, {
    hasImage: !!image,
    signal: abort.signal,
    sessionId,
    onDelta: (chunk) => send({ t: 'delta', text: chunk }),
  })

  try {
    const out = await flight.inFlight
    send({
      t: 'done',
      sessionId,
      text: out.text,
      imageFailed: out.imageFailed,
      usage: out.usage,
      rateLimit: out.rateLimit,
      timing: out.timing,
      model: out.model,
    })
    if (out.imageFailed) {
      console.error('  an image was dropped by the model on this step; narration may be blind')
    }
  } catch (e) {
    if (!abort.signal.aborted) send({ t: 'error', error: String(e.message || e) })
  } finally {
    flight.inFlight = null
    releaseFlight(sessionId)
    req.off('aborted', onClientGone)
    if (!res.writableEnded) res.end()
  }
}

/** One call at the end of a session. Writes the SOP to out/. */
async function synthesize(req, res) {
  const body = await readJson(req)
  const session = body && body.session
  if (!session || !Array.isArray(session.steps) || !session.steps.length) {
    return json(res, 400, { ok: false, error: 'a session with steps is required' })
  }

  let clean
  try {
    clean = scrub.scrubPayload({
      goal: session.goal, company: session.company, steps: session.steps,
    })
  } catch (e) {
    return json(res, 200, { ok: false, error: 'redaction failed, nothing sent: ' + e.message })
  }

  const out = await C.run('synthesize', scrub.renderSopPrompt(clean), {
    upgradeModel: !!body.upgradeModel,
  })

  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')
  // PATH TRAVERSAL: session.company arrives in the request body, and the relay accepts
  // arbitrary JSON, so a company of "../../Windows/Temp" would write outside out/. The panel
  // only offers two values, but the endpoint is not the panel.
  const dir = path.join(OUT_DIR, safeSegment(session.company), stamp)
  fs.mkdirSync(dir, { recursive: true })
  const mdPath = path.join(dir, 'SOP.md')
  fs.writeFileSync(mdPath, out.text, 'utf8')
  fs.writeFileSync(path.join(dir, 'steps.json'), JSON.stringify(clean, null, 2), 'utf8')

  json(res, 200, {
    ok: true,
    markdown: out.text,
    dir,
    usage: out.usage,
    rateLimit: out.rateLimit,
    model: out.model,
  })
}

/**
 * Export a synthesized session as a /sop-to-video bundle.
 *
 * Deliberately a separate route rather than part of synthesize(). Synthesis is the path that
 * produces the document, it works, and it is the expensive call. Bundling is a second,
 * optional artifact, and a failure here must never cost the SOP.
 *
 * Body: { dir, session, frames: [{ n, base64 }] }
 * `frames` must be the REDACTED model frames only. before/after frames are full viewport
 * captures with nothing painted over them and must never leave the browser.
 */
async function bundleRoute(req, res) {
  const body = await readJson(req)
  const session = body && body.session
  if (!session || !Array.isArray(session.steps) || !session.steps.length) {
    return json(res, 400, { ok: false, error: 'a session with steps is required' })
  }

  // PATH TRAVERSAL, again: `dir` comes from the request body. synthesize() hands the panel a
  // real path and the panel hands it back, but the endpoint is not the panel. Resolve it and
  // require that it actually sits under OUT_DIR, so no payload can aim a write elsewhere.
  const raw = typeof body.dir === 'string' ? body.dir : ''
  const dir = path.resolve(raw)
  const root = path.resolve(OUT_DIR)
  if (!raw || (dir !== root && !dir.startsWith(root + path.sep))) {
    return json(res, 400, { ok: false, error: 'dir must be a path inside out/' })
  }
  if (!fs.existsSync(dir)) {
    return json(res, 400, { ok: false, error: 'dir does not exist, synthesize first' })
  }

  // Scrub again. The frames are already redacted in the browser, but the step prose in this
  // payload is client supplied and this is the fail closed rule: if the scrubber throws we do
  // not know what is in it, so nothing gets written.
  let clean
  try {
    clean = scrub.scrubPayload({ goal: session.goal, company: session.company, steps: session.steps })
  } catch (e) {
    return json(res, 200, { ok: false, error: 'redaction failed, nothing written: ' + e.message })
  }

  try {
    const out = bundle.writeBundle({
      dir,
      session: { ...clean, goal: session.goal },
      frames: body.frames,
    })
    if (!out.ok) return json(res, 200, { ok: false, error: out.error })
    if (out.missingFrames.length) {
      console.error('  bundle: ' + out.missingFrames.length +
        ' step(s) have no screenshot: ' + out.missingFrames.join(', '))
    }
    return json(res, 200, out)
  } catch (e) {
    return json(res, 200, { ok: false, error: 'bundle failed: ' + e.message })
  }
}

/** Exactly what would be sent, so redaction is verifiable rather than asserted. */
async function preview(req, res) {
  const body = await readJson(req)
  try {
    const clean = scrub.scrubPayload(body || {})
    json(res, 200, { ok: true, prompt: scrub.renderNarrationPrompt(clean), payload: clean })
  } catch (e) {
    json(res, 200, { ok: false, error: e.message })
  }
}

// --- plumbing ---------------------------------------------------------------

/**
 * One path segment, never an escape. Anything not a plain lowercase word becomes 'unknown'
 * rather than being sanitized in place, because a name mangled into something else is worse
 * than an obvious placeholder when you are looking for your own output.
 */
function safeSegment(raw) {
  const s = String(raw || 'personal').toLowerCase().trim()
  if (!/^[a-z0-9][a-z0-9_-]{0,40}$/.test(s)) return 'unknown'
  return s
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (c) => {
      size += c.length
      if (size > MAX_BODY) { req.destroy(); return reject(new Error('body too large')) }
      chunks.push(c)
    })
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))) }
      catch (e) { reject(new Error('bad json: ' + e.message)) }
    })
    req.on('error', reject)
  })
}

function json(res, code, obj) {
  end(res, code, JSON.stringify(obj), 'application/json; charset=utf-8')
}

function end(res, code, body, type) {
  if (res.headersSent) { try { res.end() } catch {} return }
  res.writeHead(code, type ? { 'content-type': type } : {})
  res.end(body)
}

// A listen failure is not an exception you can shrug off, and EADDRINUSE has exactly one
// cause in practice: a relay is already running. Say that, instead of a stack trace.
server.on('error', (e) => {
  if (e && e.code === 'EADDRINUSE') {
    console.error('\n  Port ' + PORT + ' is already in use, so this relay did not start.')
    console.error('  A relay is almost certainly already running. Use that window, or close it first.')
    console.error('  To find it:  netstat -ano | findstr :' + PORT + '\n')
  } else {
    console.error('\n  The relay could not start: ' + (e && e.message || e) + '\n')
  }
  process.exit(1)
})

server.listen(PORT, HOST, () => {
  listening = true
  let authNote = 'not logged in yet, narration will fail until you do'
  try {
    if (hasOauth(path.join(C.configDir(), '.claude.json'))) authNote = 'logged in'
  } catch {}
  console.log('')
  const isolated = path.resolve(C.configDir()) === path.resolve(path.join(__dirname, '.claude-home'))
  console.log('  oruga-scribe relay')
  console.log('  listening   http://' + HOST + ':' + PORT)
  console.log('  config dir  ' + C.configDir())
  if (!isolated) {
    console.log('              WARNING: this is NOT the project isolated dir.')
    console.log('              If it is the machine default, calls spend the Promise seat.')
  }
  console.log('  auth        ' + authNote)
  const bl = loadBlocklist()
  console.log('  blocklist   ' + (bl > 0 ? bl + ' custom entries from relay/blocklist.json'
    : bl === 0 ? 'none (add relay/blocklist.json to redact your own strings)'
      : 'FAILED TO LOAD, see the error above'))
  console.log('  output      ' + OUT_DIR)
  console.log('')
  if (authNote !== 'logged in') {
    console.log('  To log in, from the repo root:')
    console.log('    CLAUDE_CONFIG_DIR="$PWD/relay/.claude-home" claude auth login')
    console.log('')
  }
})
