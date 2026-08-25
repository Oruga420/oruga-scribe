/**
 * test/repro-second-recording.mjs
 *
 * Reproduces: "no me deja iniciar uno nuevo".
 * Record, stop, reload the panel, then try to start a SECOND recording.
 *
 *   TARGET_URL=https://example.com node test/repro-second-recording.mjs
 */

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { spawn } from 'node:child_process'
import { pathToFileURL } from 'node:url'

const ROOT = path.join(import.meta.dirname, '..')
const EXT = path.join(ROOT, 'apps', 'extension')
const OUT = path.join(ROOT, 'evidence-repro')
const TARGET = process.env.TARGET_URL || 'https://example.com/'
const PORT = 9336
const CHROME = process.env.CHROME_EXE || path.join(os.homedir(),
  'AppData', 'Local', 'ms-playwright', 'chromium-1234', 'chrome-win64', 'chrome.exe')

fs.rmSync(OUT, { recursive: true, force: true })
fs.mkdirSync(OUT, { recursive: true })
const LOG = path.join(OUT, 'repro.log')
function log(s) { console.log(s); try { fs.appendFileSync(LOG, s + '\n') } catch {} }

const profile = path.join(os.tmpdir(), 'oruga-repro-' + process.pid)
const child = spawn(CHROME, [
  '--remote-debugging-port=' + PORT,
  '--user-data-dir=' + profile,
  '--load-extension=' + EXT,
  '--disable-extensions-except=' + EXT,
  '--enable-unsafe-extension-debugging',
  // The Chrome for Testing binary in the playwright cache can hit
  // 'Sandbox cannot access executable ... Access is denied' depending on how it was unpacked.
  // This is a local test harness driving our own extension, so dropping the sandbox is fine.
  '--no-sandbox', '--disable-gpu',
  '--no-first-run', '--no-default-browser-check', '--window-size=1280,900',
  'about:blank',
], { stdio: 'ignore' })
process.on('exit', () => {
  try { child.kill() } catch {}
  try { fs.rmSync(profile, { recursive: true, force: true, maxRetries: 2 }) } catch {}
})

async function cdp(p) {
  const r = await fetch('http://127.0.0.1:' + PORT + p, { signal: AbortSignal.timeout(3000) })
  return r.json()
}
let ver = null
for (let i = 0; i < 40 && !ver; i++) {
  try { ver = await cdp('/json/version') } catch { await new Promise((r) => setTimeout(r, 500)) }
}
if (!ver) { log('debug port never opened'); process.exit(1) }

let extId = null
for (let i = 0; i < 30 && !extId; i++) {
  const t = await cdp('/json/list').catch(() => [])
  const m = t.find((x) => x.url && x.url.endsWith('/sw.js'))
  if (m) extId = new URL(m.url).host
  else await new Promise((r) => setTimeout(r, 500))
}
log('extension id ' + extId)

const { chromium } = await import(
  pathToFileURL(path.join(ROOT, '.tools', 'node_modules', 'playwright', 'index.mjs')).href)
const browser = await chromium.connectOverCDP('http://127.0.0.1:' + PORT)
const ctx = browser.contexts()[0]

const target = ctx.pages()[0] || await ctx.newPage()
await target.goto(TARGET, { waitUntil: 'domcontentloaded', timeout: 40_000 }).catch(() => {})
await target.reload({ waitUntil: 'domcontentloaded' }).catch(() => {})
await target.waitForTimeout(3000)

const panelUrl = 'chrome-extension://' + extId + '/panel/panel.html'
let panel = await ctx.newPage()
const errs = []
panel.on('pageerror', (e) => errs.push('pageerror: ' + e.message))
panel.on('console', (m) => { if (m.type() === 'error') errs.push('console: ' + m.text()) })
await panel.goto(panelUrl)
await panel.waitForTimeout(1200)

async function whichPane() {
  return await panel.evaluate(() => {
    const vis = (id) => !document.getElementById(id).classList.contains('hidden')
    return { setup: vis('setup'), rec: vis('rec'), review: vis('review'),
      state: document.getElementById('state').textContent,
      banner: document.getElementById('banner').classList.contains('hidden')
        ? '' : document.getElementById('banner').textContent.slice(0, 110),
      setupErr: document.getElementById('setupErr').textContent }
  })
}

// --- FIRST recording ------------------------------------------------------
log('\n--- first recording ---')
log('pane on fresh boot: ' + JSON.stringify(await whichPane()))
await panel.fill('#goal', 'First recording, document the page')
await panel.click('#start')
await panel.waitForTimeout(2500)
const p1 = await whichPane()
log('after start:        ' + JSON.stringify(p1))
if (/No capture on this page/.test(p1.banner)) {
  log('')
  log('framesReached was 0. Diagnosing why the content script is not reachable...')
  const diag = await panel.evaluate(async () => {
    const out = {}
    const tabs = await chrome.tabs.query({})
    out.tabs = tabs.map((t) => ({ id: t.id, active: t.active, url: String(t.url).slice(0, 60) }))
    const target = tabs.find((t) => t.url && !t.url.startsWith('chrome-extension://') && !t.url.startsWith('chrome://'))
    out.chosen = target ? { id: target.id, url: String(target.url).slice(0, 60) } : null
    if (!target) return out
    try {
      out.frames = (await chrome.webNavigation.getAllFrames({ tabId: target.id }) || []).map((f) => f.frameId)
    } catch (e) { out.framesError = e.message }
    // Can we reach the content script at all?
    try {
      out.probe = await chrome.tabs.sendMessage(target.id, { to: 'oruga-capture', kind: 'probe' })
    } catch (e) { out.probeError = e.message }
    // Does injecting it right now help?
    try {
      await chrome.scripting.executeScript({ target: { tabId: target.id, allFrames: true }, files: ['content/capture.js'] })
      out.injected = true
      out.probeAfterInject = await chrome.tabs.sendMessage(target.id, { to: 'oruga-capture', kind: 'probe' })
    } catch (e) { out.injectError = e.message }
    return out
  })
  log(JSON.stringify(diag, null, 1))
  await browser.close().catch(() => {})
  process.exit(3)
}

await target.bringToFront()
for (const sel of ['h1', 'a', 'p']) {
  const loc = target.locator(sel).first()
  if (await loc.count().catch(() => 0)) {
    await loc.click({ timeout: 4000 }).catch(() => {})
    await target.waitForTimeout(1600)
  }
}
await panel.bringToFront()
await panel.waitForTimeout(2000)

const stepCount = await panel.evaluate(() => document.querySelectorAll('#steps .step').length)
log('steps captured:     ' + stepCount)
await panel.click('#stop')
await panel.waitForTimeout(2000)
log('after stop:         ' + JSON.stringify(await whichPane()))
if (stepCount === 0) {
  log('')
  log('ABORTING: zero steps, so the reload path cannot be tested.')
  await browser.close().catch(() => {})
  process.exit(3)
}

// --- reload the panel, exactly what a user does ---------------------------
log('\n--- reloading the panel ---')
await panel.reload()
await panel.waitForTimeout(2500)
const afterReload = await whichPane()
log('after reload:       ' + JSON.stringify(afterReload))

// --- try to start a SECOND recording -------------------------------------
log('\n--- trying to start a SECOND recording ---')
if (afterReload.review) {
  log('in review, clicking "Keep recording"...')
  await panel.click('#back')
  await panel.waitForTimeout(2000)
  log('after Keep recording: ' + JSON.stringify(await whichPane()))
}

const pane = await whichPane()
if (!pane.setup) {
  log('\nFAILED: cannot reach the setup pane, so a new recording cannot be started.')
} else {
  const goalDisabled = await panel.locator('#goal').isDisabled().catch(() => 'n/a')
  const startDisabled = await panel.locator('#start').isDisabled().catch(() => 'n/a')
  log('setup reachable. goal disabled=' + goalDisabled + ' start disabled=' + startDisabled)
  await panel.fill('#goal', 'Second recording, a different task entirely')
  await panel.click('#start')
  await panel.waitForTimeout(3000)
  const after = await whichPane()
  log('after second start:  ' + JSON.stringify(after))
  if (after.rec) log('\nOK: second recording started.')
  else log('\nFAILED: second start did not enter the recording pane.')
}

await panel.screenshot({ path: path.join(OUT, 'final.png') })
log('\npanel errors: ' + (errs.length ? JSON.stringify(errs.slice(0, 6), null, 1) : 'none'))
await browser.close().catch(() => {})
process.exit(0)
