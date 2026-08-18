/**
 * test/probe-cdp.mjs - launch Chrome ourselves, then attach over CDP.
 *
 * Playwright's launchPersistentContext never got --load-extension to take effect, even with
 * --disable-extensions removed and --enable-unsafe-extension-debugging added:
 * chrome://extensions-internals showed only component extensions. So take Playwright out of
 * the launch path entirely and control every argument here.
 */

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { spawn } from 'node:child_process'
import { pathToFileURL } from 'node:url'

const ROOT = path.join(import.meta.dirname, '..')
const EXT = path.join(ROOT, 'extension')
const OUT = path.join(ROOT, 'evidence')
fs.mkdirSync(OUT, { recursive: true })
const LOG = path.join(OUT, 'probe-cdp.log')
fs.writeFileSync(LOG, '')
function log(s) { console.log(s); fs.appendFileSync(LOG, s + '\n') }

const CHROME = process.env.CHROME_EXE
  || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const PORT = 9333
const profile = path.join(os.tmpdir(), 'oruga-cdp-' + process.pid)

log('launching chrome ourselves')
log('  chrome  ' + CHROME)
log('  ext     ' + EXT)
log('  profile ' + profile)

const args = [
  '--remote-debugging-port=' + PORT,
  '--user-data-dir=' + profile,
  '--load-extension=' + EXT,
  '--disable-extensions-except=' + EXT,
  '--enable-unsafe-extension-debugging',
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-features=DestroyProfileOnBrowserClose',
  '--window-size=1280,900',
  'about:blank',
]
log('  args    ' + args.filter((a) => a.startsWith('--load') || a.startsWith('--enable')).join(' '))

const child = spawn(CHROME, args, { detached: false, stdio: 'ignore', windowsHide: false })
let closed = false
child.on('exit', (c) => { closed = true; log('  chrome exited with ' + c) })

// Wait for the debugging endpoint.
async function waitForCdp() {
  for (let i = 0; i < 40; i++) {
    try {
      const r = await fetch('http://127.0.0.1:' + PORT + '/json/version', { signal: AbortSignal.timeout(1500) })
      if (r.ok) return await r.json()
    } catch { /* not up yet */ }
    if (closed) throw new Error('chrome exited before the debug port opened')
    await new Promise((r) => setTimeout(r, 500))
  }
  throw new Error('debug port never opened')
}

const version = await waitForCdp()
log('\n  CDP up: ' + version['Browser'] + '  ws=' + String(version.webSocketDebuggerUrl).slice(0, 48) + '...')

// List every target. An extension shows up as a service_worker or background_page target.
const targets = await (await fetch('http://127.0.0.1:' + PORT + '/json/list')).json()
log('\n  targets (' + targets.length + '):')
for (const t of targets) {
  log('    [' + t.type + '] ' + String(t.url).slice(0, 95))
}

const mine = targets.find((t) => t.url && t.url.includes('/sw.js'))
if (mine) {
  const id = new URL(mine.url).host
  log('\n  OUR EXTENSION IS LOADED. id=' + id)
  fs.writeFileSync(path.join(OUT, 'extension-id.txt'), id)
} else {
  log('\n  our sw.js is not among the targets.')
}

// Attach Playwright over CDP and read extensions-internals for the definitive list.
const { chromium } = await import(
  pathToFileURL(path.join(ROOT, '.tools', 'node_modules', 'playwright', 'index.mjs')).href)
const browser = await chromium.connectOverCDP('http://127.0.0.1:' + PORT)
const ctx = browser.contexts()[0]
const page = ctx.pages()[0] || await ctx.newPage()

await page.goto('chrome://extensions-internals', { timeout: 15000 }).catch((e) => log('  nav failed: ' + e.message))
await page.waitForTimeout(1500)
const dump = await page.evaluate(() => document.body.innerText).catch(() => '')
fs.writeFileSync(path.join(OUT, 'extensions-internals-cdp.json'), dump || '(empty)')
log('\n  installed extensions per Chrome:')
try {
  const list = JSON.parse(dump)
  for (const e of (Array.isArray(list) ? list : list.extensions || [])) {
    log('    ' + e.id + '  ' + ((e.manifest && e.manifest.name) || '?') + '  [' + (e.location || '?') + ']')
  }
} catch { log('    unparseable: ' + String(dump).slice(0, 200)) }

log('  serviceWorkers via playwright: ' + JSON.stringify(ctx.serviceWorkers().map((w) => w.url())))

await browser.close().catch(() => {})
try { child.kill() } catch {}
log('\ndone')
process.exit(0)
