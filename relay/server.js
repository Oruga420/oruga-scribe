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

const PORT = Number(process.env.SCRIBE_PORT || 8787)
const HOST = '127.0.0.1'
const OUT_DIR = path.join(__dirname, '..', 'out')
const MAX_BODY = 32 * 1024 * 1024   // a 40 step session with base64 frames

// Narration must never run two spawns at once: overlapping calls stack Node processes and
// the panel falls progressively behind. Single flight, with newly arrived steps merged
// into the next payload instead of queued as another call.
let inFlight = null
let mergeBuffer = []

const server = http.createServer(async (req, res) => {
  const origin = req.headers.origin || ''
  const allowed = !origin || origin.startsWith('chrome-extension://')

  res.setHeader('Access-Control-Allow-Origin', allowed ? (origin || '*') : 'null')
  res.setHeader('Access-Control-Allow-Headers', 'content-type')
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS')
  res.setHeader('Vary', 'Origin')

  if (req.method === 'OPTIONS') return end(res, 204, '')
  if (!allowed) return json(res, 403, { ok: false, error: 'origin not allowed: ' + origin })

  try {
    if (req.url === '/health') return health(res)
    if (req.url === '/narrate' && req.method === 'POST') return narrate(req, res)
    if (req.url === '/synthesize' && req.method === 'POST') return synthesize(req, res)
    if (req.url === '/preview' && req.method === 'POST') return preview(req, res)
    return json(res, 404, { ok: false, error: 'no such route' })
  } catch (e) {
    return json(res, 500, { ok: false, error: String(e && e.message || e) })
  }
})

// --- routes -----------------------------------------------------------------

function health(res) {
  let loggedIn = false
  let exe = null
  let detail = ''
  try {
    exe = C.resolveExe()
    loggedIn = fs.existsSync(path.join(C.configDir(), 'credentials.json'))
      || hasOauth(path.join(C.configDir(), '.claude.json'))
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

  if (inFlight) {
    // Merge rather than queue. The panel gets one narration covering both groups.
    mergeBuffer.push(...body.steps)
    return json(res, 202, { ok: true, merged: true, pending: mergeBuffer.length })
  }

  const steps = body.steps.concat(mergeBuffer.splice(0))

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

  inFlight = C.run('narrate', payload, {
    hasImage: !!image,
    onDelta: (chunk) => res.write(JSON.stringify({ t: 'delta', text: chunk }) + '\n'),
  })

  try {
    const out = await inFlight
    res.write(JSON.stringify({
      t: 'done',
      text: out.text,
      imageFailed: out.imageFailed,
      usage: out.usage,
      rateLimit: out.rateLimit,
      timing: out.timing,
      model: out.model,
    }) + '\n')
  } catch (e) {
    res.write(JSON.stringify({ t: 'error', error: String(e.message || e) }) + '\n')
  } finally {
    inFlight = null
    res.end()
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
  const dir = path.join(OUT_DIR, session.company || 'personal', stamp)
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

server.listen(PORT, HOST, () => {
  let authNote = 'not logged in yet, narration will fail until you do'
  try {
    if (hasOauth(path.join(C.configDir(), '.claude.json'))) authNote = 'logged in'
  } catch {}
  console.log('')
  console.log('  oruga-scribe relay')
  console.log('  listening   http://' + HOST + ':' + PORT)
  console.log('  config dir  ' + C.configDir())
  console.log('  auth        ' + authNote)
  console.log('  output      ' + OUT_DIR)
  console.log('')
  if (authNote !== 'logged in') {
    console.log('  To log in, from the repo root:')
    console.log('    CLAUDE_CONFIG_DIR="$PWD/relay/.claude-home" claude auth login')
    console.log('')
  }
})
