/**
 * test/evidence.mjs - proof that the extension works, in a real browser, on a real page.
 *
 *   node test/evidence.mjs
 *
 * Launches Chrome for Testing with the unpacked extension loaded, attaches over CDP, opens the
 * real side panel page, starts a real recording, performs real mouse clicks on a real site,
 * reads back what the extension recorded, and asks the relay to write the SOP.
 *
 * Everything lands in evidence/ as PNGs and JSON so nothing has to be taken on trust.
 *
 * WHY IT IS BUILT THIS WAY, each point cost a debugging round:
 *   - Branded Chrome 151 does NOT honour --load-extension. Verified by launching it directly
 *     with clean args: chrome://extensions-internals listed only COMPONENT extensions. Chrome
 *     for Testing (Playwright's bundled chromium) does honour it, so that is what we use.
 *   - Playwright's launchPersistentContext injects --disable-extensions, which silently kills
 *     the load. We bypass it entirely by spawning the browser ourselves.
 *   - Node fully buffers stdout to a file, so a hang shows an empty log. Everything is logged
 *     synchronously to evidence/run.log as well.
 */

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { spawn } from 'node:child_process'
import { pathToFileURL } from 'node:url'

const ROOT = path.join(import.meta.dirname, '..')
const EXT = path.join(ROOT, 'extension')
const OUT = path.join(ROOT, 'evidence')
const TARGET = process.env.TARGET_URL || 'https://delphi-web-proxy-11570296898.us-central1.run.app/'
const GOAL = process.env.GOAL || 'Open Delphi and sign in so I can use it'
const RELAY = process.env.RELAY || 'http://127.0.0.1:8787'
const PORT = 9334

const CHROME = process.env.CHROME_EXE || path.join(os.homedir(),
  'AppData', 'Local', 'ms-playwright', 'chromium-1234', 'chrome-win64', 'chrome.exe')

fs.rmSync(OUT, { recursive: true, force: true })
fs.mkdirSync(OUT, { recursive: true })
const LOGFILE = path.join(OUT, 'run.log')

function log(s) {
  console.log(s)
  try { fs.appendFileSync(LOGFILE, s + '\n') } catch { /* ignore */ }
}

const shots = []
async function shot(page, name, note) {
  const file = path.join(OUT, String(shots.length + 1).padStart(2, '0') + '-' + name + '.png')
  await page.screenshot({ path: file }).catch((e) => log('  screenshot failed: ' + e.message))
  shots.push({ file: path.basename(file), note })
  log('  shot  ' + path.basename(file) + '   ' + note)
}

log('\noruga-scribe evidence run\n' + '='.repeat(64))
log('  browser    ' + CHROME)
log('  extension  ' + EXT)
log('  target     ' + TARGET)
log('  goal       ' + GOAL)

if (!fs.existsSync(CHROME)) {
  log('\n  Chrome for Testing is missing. Install it once:')
  log('    cd .tools && npx playwright install chromium\n')
  process.exit(2)
}

// --- launch --------------------------------------------------------------

const profile = path.join(os.tmpdir(), 'oruga-evidence-' + process.pid)
const child = spawn(CHROME, [
  '--remote-debugging-port=' + PORT,
  '--user-data-dir=' + profile,
  '--load-extension=' + EXT,
  '--disable-extensions-except=' + EXT,
  '--enable-unsafe-extension-debugging',
  '--no-first-run',
  '--no-default-browser-check',
  '--window-size=1280,900',
  'about:blank',
], { stdio: 'ignore', windowsHide: false })

let browserGone = false
child.on('exit', (c) => { browserGone = true; log('  browser exited: ' + c) })
process.on('exit', () => {
  try { child.kill() } catch { /* ignore */ }
  try { fs.rmSync(profile, { recursive: true, force: true, maxRetries: 2 }) } catch { /* ignore */ }
})

async function cdp(pathname) {
  const r = await fetch('http://127.0.0.1:' + PORT + pathname, { signal: AbortSignal.timeout(3000) })
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

// --- find our extension --------------------------------------------------

let extId = null
for (let i = 0; i < 30 && !extId; i++) {
  const targets = await cdp('/json/list').catch(() => [])
  const mine = targets.find((t) => t.url && t.url.endsWith('/sw.js'))
  if (mine) extId = new URL(mine.url).host
  else await new Promise((r) => setTimeout(r, 500))
}
if (!extId) {
  log('\n  FAILED: our sw.js never appeared as a target, so the extension did not load.')
  const t = await cdp('/json/list').catch(() => [])
  log('  targets were: ' + JSON.stringify(t.map((x) => x.type + ' ' + x.url)))
  process.exit(1)
}
log('  extension loaded, id ' + extId)

// --- attach --------------------------------------------------------------

const { chromium } = await import(
  pathToFileURL(path.join(ROOT, '.tools', 'node_modules', 'playwright', 'index.mjs')).href)
const browser = await chromium.connectOverCDP('http://127.0.0.1:' + PORT)
const ctx = browser.contexts()[0]

const swErrors = []
const panelErrors = []
const pageErrors = []
for (const w of ctx.serviceWorkers()) {
  if (w.url().endsWith('/sw.js')) w.on('console', (m) => { if (m.type() === 'error') swErrors.push(m.text()) })
}

// --- the real page -------------------------------------------------------

const target = ctx.pages()[0] || await ctx.newPage()
target.on('pageerror', (e) => pageErrors.push(e.message))
await target.setViewportSize({ width: 1280, height: 800 }).catch(() => {})
log('\n  opening the target...')
await target.goto(TARGET, { waitUntil: 'domcontentloaded', timeout: 60_000 })
  .catch((e) => log('  navigation note: ' + e.message.split('\n')[0]))
await target.waitForTimeout(3000)
log('  landed on ' + target.url().slice(0, 95))
await shot(target, 'target-page', 'the real page, before recording')

// --- the real side panel -------------------------------------------------

const panel = await ctx.newPage()
panel.on('pageerror', (e) => panelErrors.push(e.message))
panel.on('console', (m) => { if (m.type() === 'error') panelErrors.push(m.text()) })
await panel.setViewportSize({ width: 420, height: 900 }).catch(() => {})
await panel.goto('chrome-extension://' + extId + '/panel/panel.html', { timeout: 20_000 })
await panel.waitForTimeout(1500)
await shot(panel, 'panel-setup', 'the real side panel: goal is required before recording')

await panel.fill('#goal', GOAL)
await panel.selectOption('#company', 'personal')
await shot(panel, 'panel-goal-filled', 'goal typed, ownership set to personal')

// Click the REAL Start button. Going through sendMessage instead would leave the panel's own
// session variable null, so its live step list would never render, and the screenshots would
// silently all look identical. That is exactly what happened on the first successful run.
log('\n  clicking the real Start button...')
await panel.click('#start')
await panel.waitForTimeout(3000)
await shot(panel, 'panel-started', 'recording started from the button, panel owns the session')

const started = await panel.evaluate(async () => {
  const r = await chrome.runtime.sendMessage({ to: 'oruga-sw', kind: 'resume' })
  return { ok: !!(r && r.session), r }
})
log('  START -> panel session=' +
  (started.r && started.r.session && started.r.session.id) +
  '  goal=' + JSON.stringify(started.r && started.r.session && started.r.session.goal))

const setupErr = await panel.locator('#setupErr').textContent().catch(() => '')
if (setupErr && setupErr.trim()) log('  panel reported: ' + setupErr.trim())
const bannerVisible = await panel.locator('#banner:not(.hidden)').count().catch(() => 0)
if (bannerVisible) log('  panel banner: ' + await panel.locator('#banner').textContent())

// --- real clicks ---------------------------------------------------------

await target.bringToFront()
await target.waitForTimeout(800)

const offered = await target.evaluate(() => {
  const out = []
  const sel = 'button, a[href], input:not([type=password]):not([type=hidden]), [role=button], [role=link], summary'
  for (const el of document.querySelectorAll(sel)) {
    const r = el.getBoundingClientRect()
    if (r.width < 10 || r.height < 10 || r.top < 0 || r.top > innerHeight - 20) continue
    const name = (el.getAttribute('aria-label') || el.innerText || el.value || el.placeholder || '').trim().slice(0, 50)
    if (!name) continue
    out.push({ name, x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) })
    if (out.length >= 3) break
  }
  return out
})
log('  page offers: ' + JSON.stringify(offered.map((o) => o.name)))

const clicks = []
for (const el of offered) {
  try {
    await target.mouse.click(el.x, el.y)
    clicks.push({ name: el.name, ok: true })
    log('  clicked "' + el.name + '"')
  } catch (e) {
    clicks.push({ name: el.name, ok: false, why: e.message.split('\n')[0].slice(0, 70) })
    log('  click failed on "' + el.name + '": ' + e.message.split('\n')[0].slice(0, 60))
  }
  await target.waitForTimeout(2000)
}

// --- what got recorded ---------------------------------------------------

await panel.bringToFront()
await panel.waitForTimeout(3000)
await shot(panel, 'panel-recording', 'the panel while recording, steps arriving live')

const stopped = await panel.evaluate(async () =>
  await chrome.runtime.sendMessage({ to: 'oruga-sw', kind: 'stop' }))
const session = stopped && stopped.session
log('\n  STOP -> ' + (session ? session.steps.length + ' steps' : 'no session'))
if (session) {
  for (const s of session.steps) {
    log('    [' + s.type + '] ' + (s.target.name || s.target.tag || '(unnamed)').slice(0, 60) +
      (s.beforeFrame ? '  frame' : '  no-frame') + (s.signal !== 'normal' ? '  ' + s.signal : ''))
  }
  fs.writeFileSync(path.join(OUT, 'session.json'), JSON.stringify(session, null, 2))
}

// Render the real review pane by clicking the real Stop button.
await panel.click('#stop').catch(() => {})
await panel.waitForTimeout(2000)
await shot(panel, 'panel-review', 'the review pane after stop')

// Pull a stored frame straight out of IndexedDB.
const framed = session && session.steps.find((s) => s.modelFrame || s.beforeFrame)
if (framed) {
  const key = framed.modelFrame || framed.beforeFrame
  const b64 = await panel.evaluate(async (k) => {
    const r = await chrome.runtime.sendMessage({ to: 'oruga-sw', kind: 'getFrame', key: k })
    return r && r.ok ? r.base64 : null
  }, key)
  if (b64) {
    const f = path.join(OUT, 'captured-frame.webp')
    fs.writeFileSync(f, Buffer.from(b64, 'base64'))
    log('  captured-frame.webp  ' + fs.statSync(f).size + ' bytes, straight from IndexedDB')
  }
}

// --- the SOP -------------------------------------------------------------

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
      fs.writeFileSync(path.join(OUT, 'SOP.md'), sop.markdown)
      log('  written to ' + sop.dir)
      log('\n' + '-'.repeat(64) + '\n' + sop.markdown + '\n' + '-'.repeat(64))
    } else {
      log('  relay refused: ' + sop.error)
    }
  } catch (e) {
    log('  relay unreachable: ' + e.message + '   (start it: node relay/server.js)')
    sop = { ok: false, error: e.message }
  }
}

// --- report --------------------------------------------------------------

const report = {
  ranAt: new Date().toISOString(),
  browser: version.Browser,
  extensionId: extId,
  target: TARGET,
  landedOn: target.url(),
  goal: GOAL,
  startOk: started.ok,
  framesReached: started.r && started.r.framesReached,
  clicks,
  stepsRecorded: session ? session.steps.length : 0,
  steps: session ? session.steps.map((s) => ({
    type: s.type, name: s.target.name, url: s.url,
    hasFrame: !!s.beforeFrame, hasModelFrame: !!s.modelFrame, signal: s.signal,
  })) : [],
  sopWritten: !!(sop && sop.ok),
  sopDir: sop && sop.dir,
  screenshots: shots,
  serviceWorkerErrors: swErrors,
  panelErrors,
  pageErrors,
}
fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify(report, null, 2))

log('\n' + '='.repeat(64))
log('  extension loaded : YES (' + extId + ')')
log('  steps recorded   : ' + report.stepsRecorded)
log('  screenshots      : ' + shots.length)
log('  SOP written      : ' + (report.sopWritten ? 'YES' : 'NO'))
log('  sw errors        : ' + (swErrors.length ? swErrors.join(' | ').slice(0, 200) : 'none'))
log('  panel errors     : ' + (panelErrors.length ? panelErrors.join(' | ').slice(0, 200) : 'none'))
log('')

await browser.close().catch(() => {})
process.exit(report.stepsRecorded > 0 ? 0 : 1)
