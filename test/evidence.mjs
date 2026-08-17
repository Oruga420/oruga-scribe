/**
 * test/evidence.mjs - proof that the extension works, in a real Chrome, on a real page.
 *
 *   npx playwright@latest test/evidence.mjs        (see run-evidence.bat)
 *
 * Not a mock. This launches actual Chrome with the unpacked extension loaded, opens the real
 * side panel page, presses the real Start button path, performs real mouse clicks on a real
 * site, then reads back what the extension recorded and asks the relay to write the SOP.
 *
 * Everything it produces lands in evidence/ as PNGs and JSON so the result can be checked
 * without taking anyone's word for it.
 */

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { pathToFileURL } from 'node:url'

const ROOT = path.join(import.meta.dirname, '..')

// Playwright lives in .tools so it never pollutes the extension or the relay, neither of which
// has any dependency at all. NODE_PATH does not apply to ESM, so resolve it by absolute path.
// index.mjs, not index.js: the CJS entry gives back a bare EventEmitter when imported from ESM.
const pwEntry = path.join(ROOT, '.tools', 'node_modules', 'playwright', 'index.mjs')
if (!fs.existsSync(pwEntry)) {
  console.error('\n  playwright is not installed. Run once:\n    cd .tools && npm install playwright@1.62.1\n')
  process.exit(2)
}
const { chromium } = await import(pathToFileURL(pwEntry).href)
const EXT = path.join(ROOT, 'extension')
const OUT = path.join(ROOT, 'evidence')
const TARGET = process.env.TARGET_URL || 'https://delphi-web-proxy-11570296898.us-central1.run.app/'
const GOAL = process.env.GOAL || 'Open Delphi and sign in so I can use it'
const RELAY = 'http://127.0.0.1:8787'

fs.rmSync(OUT, { recursive: true, force: true })
fs.mkdirSync(OUT, { recursive: true })

const shots = []
async function shot(page, name, note) {
  const file = path.join(OUT, String(shots.length + 1).padStart(2, '0') + '-' + name + '.png')
  await page.screenshot({ path: file })
  shots.push({ file: path.basename(file), note })
  console.log('  shot  ' + path.basename(file) + '  ' + note)
  return file
}

/**
 * Log synchronously to a file as well as stdout. Node fully buffers stdout when it is not a
 * TTY, so a run that hangs shows an EMPTY log and there is no way to see how far it got. That
 * cost two blind debugging rounds.
 */
const LOGFILE = path.join(OUT, 'run.log')
function log(s) {
  console.log(s)
  try { fs.appendFileSync(LOGFILE, s + '\n') } catch { /* ignore */ }
}

// A unique profile per run. Reusing one directory fails with EPERM whenever a previous run
// crashed and left Chrome holding the lock, which turns a test failure into a test that cannot
// even start.
const userDataDir = path.join(os.tmpdir(), 'oruga-scribe-evidence-' + process.pid + '-' + Date.now())
process.on('exit', () => {
  try { fs.rmSync(userDataDir, { recursive: true, force: true, maxRetries: 3 }) } catch { /* the OS can have it */ }
})

log('\noruga-scribe evidence run\n' + '='.repeat(62))
log('  extension  ' + EXT)
log('  target     ' + TARGET)
log('  goal       ' + GOAL + '\n')

log('  launching system Chrome with the extension...')
// channel 'chrome' only. The bundled chromium is not fully installed on this machine and
// launching it hangs forever with no error, which is what stalled the first two runs.
const ctx = await Promise.race([
  chromium.launchPersistentContext(userDataDir, {
    channel: 'chrome',
    headless: false,
    viewport: { width: 1280, height: 800 },
    args: [
      '--disable-extensions-except=' + EXT,
      '--load-extension=' + EXT,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-background-timer-throttling',
    ],
  }),
  new Promise((_, rej) => setTimeout(() => rej(new Error('Chrome launch timed out after 60s')), 60_000)),
])
log('  Chrome up')

// --- find the extension --------------------------------------------------

/**
 * Chrome derives an unpacked extension's id from the absolute path: sha256 of the path, first
 * 16 bytes, each nibble mapped 0-f to a-p. Computing it beats waiting for a serviceworker
 * event, which is lazy in MV3 and may never fire before we need the id.
 *
 * Windows hashes the path as UTF-16LE, other platforms as UTF-8, so try both and probe.
 */
async function findExtensionId(dir) {
  const { createHash } = await import('node:crypto')
  const variants = [
    Buffer.from(dir, 'utf16le'),
    Buffer.from(dir, 'utf8'),
    Buffer.from(dir.replace(/\//g, '\\'), 'utf16le'),
  ]
  const ids = []
  for (const buf of variants) {
    const h = createHash('sha256').update(buf).digest('hex').slice(0, 32)
    ids.push([...h].map((c) => String.fromCharCode(97 + parseInt(c, 16))).join(''))
  }
  // Probe each candidate: the manifest is fetchable only from the real id.
  const probe = await ctx.newPage()
  try {
    for (const id of [...new Set(ids)]) {
      const r = await probe.goto('chrome-extension://' + id + '/manifest.json',
        { waitUntil: 'domcontentloaded', timeout: 8000 }).catch(() => null)
      if (r && r.ok()) {
        const body = await probe.content()
        if (body.includes('oruga-scribe')) { await probe.close(); return id }
      }
    }
  } finally {
    if (!probe.isClosed()) await probe.close()
  }
  return null
}

let sw = ctx.serviceWorkers()[0]
let extId = sw ? new URL(sw.url()).host : await findExtensionId(EXT)

if (!extId) {
  log('  FAILED: the extension did not load. Candidate ids did not resolve a manifest.')
  log('  This usually means manifest.json was rejected by Chrome.')
  await ctx.close()
  process.exit(1)
}
log('  extension id  ' + extId + (sw ? '  (from service worker)' : '  (computed from path)'))

const swErrors = []
ctx.on('weberror', (e) => swErrors.push('weberror: ' + e.error().message))
function watchWorker(w) {
  w.on('console', (m) => { if (m.type() === 'error') swErrors.push('sw console: ' + m.text()) })
}
if (sw) watchWorker(sw)
ctx.on('serviceworker', (w) => { sw = w; watchWorker(w); log('  service worker started: ' + w.url()) })
log('')

// --- open the target page ------------------------------------------------

const target = await ctx.newPage()
const pageErrors = []
target.on('pageerror', (e) => pageErrors.push('page: ' + e.message))
await target.goto(TARGET, { waitUntil: 'domcontentloaded', timeout: 60_000 }).catch((e) => {
  log('  navigation warning: ' + e.message)
})
await target.waitForTimeout(2500)
log('  target landed on: ' + target.url().slice(0, 90))
await shot(target, 'target-page', 'the real page, before recording')

// --- open the real side panel page ---------------------------------------

const panel = await ctx.newPage()
const panelErrors = []
panel.on('pageerror', (e) => panelErrors.push('panel: ' + e.message))
panel.on('console', (m) => { if (m.type() === 'error') panelErrors.push('panel console: ' + m.text()) })
await panel.goto('chrome-extension://' + extId + '/panel/panel.html')
await panel.waitForTimeout(1200)
await shot(panel, 'panel-setup', 'the real side panel, goal is required before recording')

// Fill the goal the way a human does, in the real form.
await panel.fill('#goal', GOAL)
await panel.selectOption('#company', 'personal')
await shot(panel, 'panel-goal-filled', 'goal typed, company set to personal')

// Make the target tab the active one, then run the exact same start path the button uses.
// The button calls sendMessage({to:'oruga-sw', kind:'start'}); start picks the active tab, so
// activating the target first is what a human does by clicking the page before recording.
const startResult = await panel.evaluate(async ({ url, goal }) => {
  const tabs = await chrome.tabs.query({})
  const t = tabs.find((x) => x.url && !x.url.startsWith('chrome-extension://'))
  if (!t) return { ok: false, error: 'no target tab found' }
  await chrome.tabs.update(t.id, { active: true })
  await new Promise((r) => setTimeout(r, 300))
  const r = await chrome.runtime.sendMessage({ to: 'oruga-sw', kind: 'start', goal, company: 'personal' })
  return { ok: !!(r && r.ok), r, tabId: t.id }
}, { url: TARGET, goal: GOAL })

log('\n  START -> ' + JSON.stringify({
  ok: startResult.ok,
  framesReached: startResult.r && startResult.r.framesReached,
  sessionId: startResult.r && startResult.r.session && startResult.r.session.id,
}))
if (!startResult.ok) {
  log('  start failed: ' + JSON.stringify(startResult))
}

// --- real clicks on the real page ---------------------------------------

await target.bringToFront()
await target.waitForTimeout(600)

const clickLog = []
async function tryClick(desc, fn) {
  try {
    await fn()
    clickLog.push({ desc, ok: true })
    log('  click  ' + desc)
  } catch (e) {
    clickLog.push({ desc, ok: false, why: e.message.split('\n')[0].slice(0, 90) })
    log('  skip   ' + desc + '  (' + e.message.split('\n')[0].slice(0, 60) + ')')
  }
  await target.waitForTimeout(1400)
}

// Click whatever the real page actually offers. No credentials are ever typed.
const interactive = await target.evaluate(() => {
  const out = []
  const sel = 'button, a[href], input:not([type=password]):not([type=hidden]), [role=button], [role=link], summary'
  for (const el of document.querySelectorAll(sel)) {
    const r = el.getBoundingClientRect()
    if (r.width < 8 || r.height < 8 || r.top < 0 || r.top > innerHeight - 10) continue
    const name = (el.getAttribute('aria-label') || el.innerText || el.value || el.placeholder || '').trim().slice(0, 60)
    if (!name) continue
    out.push({ name, x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) })
    if (out.length >= 4) break
  }
  return out
})
log('\n  interactive elements the page offers: ' + JSON.stringify(interactive.map((i) => i.name)))

for (const el of interactive.slice(0, 3)) {
  await tryClick('"' + el.name + '"', async () => {
    await target.mouse.click(el.x, el.y)
  })
}

// --- what did the extension record? -------------------------------------

await panel.bringToFront()
await panel.waitForTimeout(2500)
await shot(panel, 'panel-recording', 'the panel during recording, steps arriving live')

const sessionId = startResult.r && startResult.r.session && startResult.r.session.id
const stopped = await panel.evaluate(async () => {
  return await chrome.runtime.sendMessage({ to: 'oruga-sw', kind: 'stop' })
})
const session = stopped && stopped.session
log('\n  STOP -> ' + (session ? session.steps.length + ' steps recorded' : 'no session returned'))

if (session) {
  for (const s of session.steps) {
    log('    [' + s.type + '] ' + (s.target.name || s.target.tag || '') +
      (s.beforeFrame ? '  frame:yes' : '  frame:no') +
      (s.signal !== 'normal' ? '  ' + s.signal : ''))
  }
  fs.writeFileSync(path.join(OUT, 'session.json'), JSON.stringify(session, null, 2))
}

// Render the review pane through the real UI, not a synthetic screenshot.
await panel.evaluate(() => document.getElementById('stop').click()).catch(() => {})
await panel.waitForTimeout(1500)
await shot(panel, 'panel-review', 'the review pane after stop, this is what was empty before')

// Pull one stored screenshot out of IndexedDB to prove frames are real.
const frameKey = session && session.steps.find((s) => s.beforeFrame)
if (frameKey) {
  const b64 = await panel.evaluate(async (key) => {
    const r = await chrome.runtime.sendMessage({ to: 'oruga-sw', kind: 'getFrame', key })
    return r && r.ok ? r.base64 : null
  }, frameKey.beforeFrame)
  if (b64) {
    const f = path.join(OUT, 'captured-frame.webp')
    fs.writeFileSync(f, Buffer.from(b64, 'base64'))
    log('  wrote  captured-frame.webp  (' + fs.statSync(f).size + ' bytes, straight out of IndexedDB)')
  }
}

// --- write the SOP through the relay ------------------------------------

let sop = null
if (session && session.steps.length) {
  log('\n  asking the relay to write the SOP...')
  try {
    const res = await fetch(RELAY + '/synthesize', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'chrome-extension://' + extId },
      body: JSON.stringify({ session }),
    })
    sop = await res.json()
    if (sop.ok) {
      log('  SOP written to ' + sop.dir)
      fs.writeFileSync(path.join(OUT, 'SOP.md'), sop.markdown)
      log('\n' + '-'.repeat(62) + '\n' + sop.markdown + '\n' + '-'.repeat(62))
    } else {
      log('  relay refused: ' + sop.error)
    }
  } catch (e) {
    log('  relay unreachable: ' + e.message + '  (is start-relay.bat running?)')
    sop = { ok: false, error: e.message }
  }
}

// --- report -------------------------------------------------------------

const report = {
  ranAt: new Date().toISOString(),
  extensionId: extId,
  target: TARGET,
  landedOn: target.url(),
  goal: GOAL,
  startOk: startResult.ok,
  framesReached: startResult.r && startResult.r.framesReached,
  clicksAttempted: clickLog,
  stepsRecorded: session ? session.steps.length : 0,
  steps: session ? session.steps.map((s) => ({
    type: s.type, name: s.target.name, url: s.url, hasFrame: !!s.beforeFrame, signal: s.signal,
  })) : [],
  sopWritten: !!(sop && sop.ok),
  sopDir: sop && sop.dir,
  screenshots: shots,
  serviceWorkerErrors: swErrors,
  panelErrors,
  pageErrors,
}
fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify(report, null, 2))

log('\n' + '='.repeat(62))
log('  steps recorded : ' + report.stepsRecorded)
log('  screenshots    : ' + shots.length + ' in evidence/')
log('  SOP written    : ' + (report.sopWritten ? 'YES -> ' + report.sopDir : 'NO'))
log('  sw errors      : ' + (swErrors.length ? swErrors.join(' | ') : 'none'))
log('  panel errors   : ' + (panelErrors.length ? panelErrors.join(' | ') : 'none'))
log('')

await ctx.close()
process.exit(report.stepsRecorded > 0 && report.sopWritten ? 0 : 1)
