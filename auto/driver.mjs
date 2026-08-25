'use strict'

/**
 * auto/driver.mjs - lets Claude Code be the hands instead of Alejandro's mouse.
 *
 * Spawns Chrome for Testing with the extension loaded, starts a real recording, then
 * exposes a tiny localhost control API so an agent can survey the page, decide what to
 * click, and click it. The EXTENSION is still the recorder: every click goes through real
 * input events, so the content script's pointerdown path, the settle race, the screenshot
 * and the redaction gate all behave exactly as they do for a human. Nothing here writes a
 * guide; the SOP still comes from the relay's synthesis pass over the recorded session.
 *
 * Why it is built this way, all of it learned the hard way in this repo:
 *   - Playwright's LAUNCHER injects --disable-extensions and silently defeats the load.
 *     We spawn the browser ourselves and use Playwright only as a CDP client.
 *   - Branded Chrome ignores --load-extension entirely. Must be Chrome for Testing.
 *   - The recording must be started by clicking the panel's real Start button. Starting it
 *     with a message leaves the panel's own session variable null, so the live list never
 *     renders and every screenshot looks identical. That happened on the first real run.
 *   - The relay's origin allowlist requires chrome-extension://, so the synthesis POST
 *     has to carry the real extension id.
 *
 * Usage:
 *   node auto/driver.mjs --url https://example.com --goal "how to create a project"
 *   node auto/driver.mjs --url ... --goal ... --user-data-dir "C:\path\to\profile"
 *
 * Then talk to it on http://127.0.0.1:8788. The control API is documented in the
 * route table at the bottom of this file, and in skill/scribe/SKILL.md.
 */

import { spawn } from 'node:child_process'
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const EXT = path.join(ROOT, 'extension')
const RELAY = process.env.RELAY || 'http://127.0.0.1:8787'
const CDP_PORT = Number(process.env.CDP_PORT || 9335)
const CTRL_PORT = Number(process.env.CTRL_PORT || 8788)
const CHROME = process.env.CHROME_EXE || path.join(os.homedir(),
  'AppData', 'Local', 'ms-playwright', 'chromium-1234', 'chrome-win64', 'chrome.exe')

// ---------------------------------------------------------------------------
// Destructive control denylist. Matched against the accessible name.
//
// This is the whole safety story of this file. A human clicking through an admin console
// knows not to press Delete. An agent does not, and a SOP is not worth a destroyed record,
// a sent email, or a charged card. Anything matching here is REFUSED unless the caller
// passes confirm:true, and the skill instructs the agent to ask Alejandro before it ever
// does. Prefer the false positive: a wrongly blocked button costs one question.
// ---------------------------------------------------------------------------
const DESTRUCTIVE = [
  // English
  'delete', 'remove', 'destroy', 'drop', 'erase', 'wipe', 'purge', 'trash',
  'send', 'submit', 'publish', 'post ', 'share', 'invite', 'transfer',
  'pay', 'charge', 'checkout', 'buy', 'purchase', 'subscribe', 'unsubscribe',
  'deactivate', 'disable', 'suspend', 'revoke', 'reset', 'restore', 'rollback',
  'archive', 'merge', 'approve', 'reject', 'deny', 'confirm', 'cancel',
  'sign out', 'log out', 'logout', 'leave', 'terminate', 'shut down',
  // Spanish
  'borrar', 'eliminar', 'quitar', 'enviar', 'publicar', 'compartir', 'invitar',
  'pagar', 'comprar', 'cancelar', 'aprobar', 'rechazar', 'restablecer',
  'desactivar', 'suspender', 'archivar', 'salir', 'cerrar sesion',
]

function riskOf(name) {
  const n = (name || '').toLowerCase()
  const hit = DESTRUCTIVE.find((w) => n.includes(w))
  return hit ? hit : null
}

// ---------------------------------------------------------------------------
// args
// ---------------------------------------------------------------------------
function arg(flag, fallback) {
  const i = process.argv.indexOf(flag)
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback
}
const TARGET_URL = arg('--url', null)
const GOAL = arg('--goal', null)
const USER_DATA_DIR = arg('--user-data-dir', null)
const COMPANY = arg('--company', 'personal')

if (!TARGET_URL || !GOAL) {
  console.error('usage: node auto/driver.mjs --url <url> --goal "<what the guide should teach>"')
  console.error('       --user-data-dir <path>   reuse an already logged in Chrome profile')
  process.exit(2)
}
if (!fs.existsSync(CHROME)) {
  console.error('Chrome for Testing is missing. Install it once:')
  console.error('  cd .tools && npx playwright install chromium')
  process.exit(2)
}

const log = (s) => console.log(s)

// ---------------------------------------------------------------------------
// launch
// ---------------------------------------------------------------------------
const ephemeralProfile = !USER_DATA_DIR
const profile = USER_DATA_DIR || path.join(os.tmpdir(), 'oruga-scribe-auto-' + process.pid)

// Sweep profiles left by earlier runs. On Windows Chrome still holds locks on its profile
// directory for a moment after the process is killed, so deleting ours during our own exit
// is unreliable and each run would leak tens of MB. By the next run those locks are long
// gone, so cleaning up on startup is the version that actually works.
if (ephemeralProfile) {
  try {
    for (const name of fs.readdirSync(os.tmpdir())) {
      if (!name.startsWith('oruga-scribe-auto-')) continue
      const p = path.join(os.tmpdir(), name)
      if (p === profile) continue
      try { fs.rmSync(p, { recursive: true, force: true, maxRetries: 3 }) } catch { /* still locked, next time */ }
    }
  } catch { /* tmpdir unreadable, not worth failing over */ }
}

log('oruga-scribe auto driver')
log('  browser   ' + CHROME)
log('  extension ' + EXT)
log('  target    ' + TARGET_URL)
log('  goal      ' + GOAL)
log('  profile   ' + profile + (ephemeralProfile ? ' (ephemeral)' : ' (reused, may already be logged in)'))

const child = spawn(CHROME, [
  '--remote-debugging-port=' + CDP_PORT,
  '--user-data-dir=' + profile,
  '--load-extension=' + EXT,
  '--disable-extensions-except=' + EXT,
  '--enable-unsafe-extension-debugging',
  // The Chrome for Testing binary in the playwright cache can hit
  // 'Sandbox cannot access executable ... Access is denied' depending on how it was unpacked.
  '--no-sandbox', '--disable-gpu',
  '--no-first-run', '--no-default-browser-check',
  '--window-size=1280,900',
  'about:blank',
], { stdio: 'ignore', windowsHide: false })

let browserGone = false
child.on('exit', (c) => { browserGone = true; log('  browser exited: ' + c) })
process.on('exit', () => {
  try { child.kill() } catch { /* ignore */ }
  // Never delete a profile the caller supplied. Only our own temp one.
  if (ephemeralProfile) {
    try { fs.rmSync(profile, { recursive: true, force: true, maxRetries: 2 }) } catch { /* ignore */ }
  }
})

async function cdp(pathname) {
  const r = await fetch('http://127.0.0.1:' + CDP_PORT + pathname, { signal: AbortSignal.timeout(3000) })
  return r.json()
}

log('\n  waiting for the debug port...')
let version = null
for (let i = 0; i < 40 && !version; i++) {
  try { version = await cdp('/json/version') } catch { /* not yet */ }
  if (browserGone) { log('  browser died before the port opened'); process.exit(1) }
  if (!version) await new Promise((r) => setTimeout(r, 500))
}
if (!version) { log('  debug port never opened'); process.exit(1) }
log('  ' + version.Browser)

let extId = null
for (let i = 0; i < 30 && !extId; i++) {
  const targets = await cdp('/json/list').catch(() => [])
  const mine = targets.find((t) => t.url && t.url.endsWith('/sw.js'))
  if (mine) extId = new URL(mine.url).host
  else await new Promise((r) => setTimeout(r, 500))
}
if (!extId) {
  log('\n  FAILED: sw.js never appeared as a target, so the extension did not load.')
  process.exit(1)
}
log('  extension loaded, id ' + extId)

const { chromium } = await import(
  pathToFileURL(path.join(ROOT, '.tools', 'node_modules', 'playwright', 'index.mjs')).href)
const browser = await chromium.connectOverCDP('http://127.0.0.1:' + CDP_PORT)
const ctx = browser.contexts()[0]

// ---------------------------------------------------------------------------
// pages
// ---------------------------------------------------------------------------
const target = await ctx.newPage()
await target.goto(TARGET_URL, { waitUntil: 'domcontentloaded', timeout: 45_000 })
  .catch((e) => log('  initial navigation warned: ' + e.message.split('\n')[0]))

const panel = await ctx.newPage()
await panel.goto('chrome-extension://' + extId + '/panel/panel.html', { timeout: 20_000 })
await panel.waitForTimeout(1200)

let recording = false
let sessionId = null

/** The page inventory an agent decides from. Includes the risk verdict per control. */
async function survey() {
  await target.bringToFront().catch(() => {})
  const items = await target.evaluate(() => {
    const out = []
    const sel = 'button, a[href], input, select, textarea, [role=button], [role=link],' +
      '[role=tab], [role=menuitem], [role=checkbox], [role=switch], summary, [onclick]'
    let i = 0
    for (const el of document.querySelectorAll(sel)) {
      const r = el.getBoundingClientRect()
      if (r.width < 8 || r.height < 8) continue
      if (r.bottom < 0 || r.top > innerHeight) continue
      const cs = getComputedStyle(el)
      if (cs.visibility === 'hidden' || cs.display === 'none' || Number(cs.opacity) === 0) continue
      const type = (el.getAttribute('type') || '').toLowerCase()
      const name = (
        el.getAttribute('aria-label') ||
        (el.labels && el.labels[0] && el.labels[0].innerText) ||
        el.innerText || el.value || el.placeholder || el.title || el.name || ''
      ).replace(/\s+/g, ' ').trim().slice(0, 80)
      if (!name) continue
      out.push({
        i: i++,
        name,
        tag: el.tagName.toLowerCase(),
        role: el.getAttribute('role') || type || null,
        // A password field is never typed into and never read. The content script already
        // refuses to read its value; the driver refuses to write one.
        secret: type === 'password' || /pass|otp|cvv|cvc|card/i.test(el.name || el.id || ''),
        x: Math.round(r.x + r.width / 2),
        y: Math.round(r.y + r.height / 2),
      })
      if (out.length >= 60) break
    }
    return out
  }).catch(() => [])
  return items.map((it) => ({ ...it, risk: riskOf(it.name) }))
}

async function stepCount() {
  const r = await panel.evaluate(async () =>
    await chrome.runtime.sendMessage({ to: 'oruga-sw', kind: 'resume' })).catch(() => null)
  return r && r.session ? r.session.steps.length : 0
}

// ---------------------------------------------------------------------------
// control API. Zero dependencies, loopback only, same shape as the relay.
// ---------------------------------------------------------------------------
const json = (res, code, body) => {
  const s = JSON.stringify(body)
  res.writeHead(code, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(s) })
  res.end(s)
}

async function readBody(req) {
  const chunks = []
  let n = 0
  for await (const c of req) {
    n += c.length
    if (n > 1_000_000) throw new Error('body too large')
    chunks.push(c)
  }
  if (!chunks.length) return {}
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

const routes = {
  async 'GET /state'() {
    return {
      ok: true, recording, sessionId, extId, url: target.url(),
      steps: recording ? await stepCount() : 0,
      goal: GOAL, relay: RELAY,
    }
  },

  async 'GET /survey'() {
    const items = await survey()
    return { ok: true, url: target.url(), title: await target.title().catch(() => ''), items }
  },

  async 'POST /start'() {
    if (recording) return { ok: false, error: 'already recording' }
    // Fill the panel's own setup fields, then click the REAL Start button. Doing this by
    // message instead leaves the panel's session null and the live list never renders.
    await panel.bringToFront()
    await panel.fill('#goal', GOAL).catch(() => {})
    await panel.selectOption('#company', COMPANY).catch(() => {})
    await panel.click('#start')
    await panel.waitForTimeout(2500)
    const err = (await panel.locator('#setupErr').textContent().catch(() => '') || '').trim()
    const r = await panel.evaluate(async () =>
      await chrome.runtime.sendMessage({ to: 'oruga-sw', kind: 'resume' })).catch(() => null)
    if (!r || !r.session) return { ok: false, error: err || 'panel did not open a session' }
    recording = true
    sessionId = r.session.id
    await target.bringToFront()
    return { ok: true, sessionId, goal: r.session.goal, warning: err || undefined }
  },

  async 'POST /click'(body) {
    if (!recording) return { ok: false, error: 'not recording, POST /start first' }
    const items = await survey()
    const it = typeof body.i === 'number'
      ? items.find((x) => x.i === body.i)
      : items.find((x) => x.name === body.name) ||
        items.find((x) => x.name.toLowerCase().includes(String(body.name || '').toLowerCase()))
    if (!it) return { ok: false, error: 'no visible control matched', offered: items.map((x) => x.name) }
    if (it.risk && !body.confirm) {
      return {
        ok: false, blocked: true, matched: it.risk, control: it.name,
        error: 'refused: this looks destructive. Ask Alejandro, then retry with confirm:true.',
      }
    }
    const before = await stepCount()
    // A real mouse click, so the content script sees a real pointerdown. Synthetic
    // dispatchEvent would not carry isTrusted and the capture path would differ.
    await target.mouse.click(it.x, it.y)
    // The capture pipeline debounces on a quiet MutationObserver with a 2.5s ceiling,
    // so give it room before reporting what landed.
    await target.waitForTimeout(2600)
    const after = await stepCount()
    return {
      ok: true, clicked: it.name, recorded: after > before,
      steps: after, url: target.url(), items: await survey(),
    }
  },

  async 'POST /type'(body) {
    if (!recording) return { ok: false, error: 'not recording, POST /start first' }
    const items = await survey()
    const it = typeof body.i === 'number'
      ? items.find((x) => x.i === body.i)
      : items.find((x) => x.name === body.name)
    if (!it) return { ok: false, error: 'no visible field matched', offered: items.map((x) => x.name) }
    if (it.secret) {
      return {
        ok: false, blocked: true, control: it.name,
        error: 'refused: this is a credential field. Never type credentials. ' +
          'Ask Alejandro to log in himself in the open browser window, then continue.',
      }
    }
    if (typeof body.text !== 'string' || !body.text) return { ok: false, error: 'text required' }
    await target.mouse.click(it.x, it.y)
    await target.keyboard.type(body.text, { delay: 25 })
    await target.waitForTimeout(1200)
    return { ok: true, typed: it.name, steps: await stepCount(), items: await survey() }
  },

  async 'POST /navigate'(body) {
    if (!body.url) return { ok: false, error: 'url required' }
    await target.goto(body.url, { waitUntil: 'domcontentloaded', timeout: 45_000 })
    await target.waitForTimeout(1500)
    return { ok: true, url: target.url(), items: await survey() }
  },

  async 'POST /shot'(body) {
    const dir = path.join(ROOT, 'out', '_auto-shots')
    fs.mkdirSync(dir, { recursive: true })
    const file = path.join(dir, (body.name || 'shot') + '-' + Date.now() + '.png')
    await target.screenshot({ path: file })
    return { ok: true, file }
  },

  /** Stop the recording and hand the pruned session to the relay for synthesis. */
  async 'POST /finish'() {
    if (!recording) return { ok: false, error: 'not recording' }
    // Probe the relay BEFORE stopping. Stopping first and then discovering the relay is
    // down ends the recording with nothing to show for it: the session survives in
    // IndexedDB, but the agent can no longer keep clicking to extend it. Found while
    // testing this file with the relay deliberately stopped.
    const up = await fetch(RELAY + '/health', { signal: AbortSignal.timeout(4000) })
      .then((r) => r.ok).catch(() => false)
    if (!up) {
      return {
        ok: false, stillRecording: true,
        error: 'relay is not reachable at ' + RELAY + ', so the recording was NOT stopped. ' +
          'Start it with `node relay/server.js` and call /finish again.',
      }
    }
    const stopped = await panel.evaluate(async () =>
      await chrome.runtime.sendMessage({ to: 'oruga-sw', kind: 'stop' })).catch(() => null)
    recording = false
    const session = stopped && stopped.session
    if (!session) return { ok: false, error: 'stop returned no session' }
    if (!session.steps || !session.steps.length) {
      return { ok: false, error: 'recorded zero steps, nothing to synthesize', session: { id: session.id } }
    }
    const res = await fetch(RELAY + '/synthesize', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'chrome-extension://' + extId },
      body: JSON.stringify({ session }),
    }).catch((e) => ({ ok: false, _err: e.message }))
    if (res._err) return { ok: false, error: 'relay unreachable: ' + res._err + ' (is node relay/server.js running?)' }
    const out = await res.json().catch(() => ({}))
    return { ok: !!out.ok, steps: session.steps.length, relay: out }
  },

  async 'POST /quit'() {
    // Give Chrome a moment to die and release its profile locks before we try to remove it.
    // Best effort only: the reliable cleanup is the startup sweep above.
    setTimeout(async () => {
      try { child.kill() } catch { /* already gone */ }
      await new Promise((r) => setTimeout(r, 1500))
      if (ephemeralProfile) {
        try { fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5 }) } catch { /* swept next run */ }
      }
      process.exit(0)
    }, 100)
    return { ok: true, bye: true }
  },
}

const server = http.createServer(async (req, res) => {
  const key = req.method + ' ' + (req.url || '').split('?')[0]
  const handler = routes[key]
  if (!handler) return json(res, 404, { ok: false, error: 'no route ' + key, routes: Object.keys(routes) })
  try {
    const body = req.method === 'POST' ? await readBody(req) : {}
    return json(res, 200, await handler(body))
  } catch (e) {
    return json(res, 200, { ok: false, error: e.message })
  }
})

// A dead browser makes every route a lie, so say so instead of timing out.
process.on('unhandledRejection', (e) => log('  unhandledRejection: ' + (e && e.message)))
process.on('uncaughtException', (e) => log('  uncaughtException: ' + (e && e.message)))

server.listen(CTRL_PORT, '127.0.0.1', () => {
  log('\n  control API on http://127.0.0.1:' + CTRL_PORT)
  log('  routes: ' + Object.keys(routes).join(', '))
  log('\n  browser is open. If the tool needs a login, log in NOW in that window, then POST /start.\n')
})
