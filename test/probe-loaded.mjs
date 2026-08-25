/**
 * test/probe-loaded.mjs - did Chrome actually load the unpacked extension?
 *
 * Both computed ids returned ERR_BLOCKED_BY_CLIENT, which is ambiguous: it means either the id
 * is wrong or the extension is not there. This settles it by looking at chrome://version for
 * the real command line and chrome://extensions for what Chrome thinks is installed.
 */

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { pathToFileURL } from 'node:url'

const ROOT = path.join(import.meta.dirname, '..')
const EXT = path.join(ROOT, 'apps', 'extension')
const OUT = path.join(ROOT, 'evidence')
fs.mkdirSync(OUT, { recursive: true })

const { chromium } = await import(
  pathToFileURL(path.join(ROOT, '.tools', 'node_modules', 'playwright', 'index.mjs')).href)

const dir = path.join(os.tmpdir(), 'oruga-loaded-' + process.pid)
const LOG = path.join(OUT, 'probe-loaded.log')
fs.writeFileSync(LOG, '')
function log(s) { console.log(s); fs.appendFileSync(LOG, s + '\n') }

log('probe: did the extension load?')
log('  ext dir: ' + EXT)

const ctx = await chromium.launchPersistentContext(dir, {
  channel: 'chrome',
  headless: false,
  viewport: { width: 1280, height: 900 },
  ignoreDefaultArgs: ['--disable-extensions'],
  args: [
    // Recent Chrome ignores --load-extension unless extension debugging is explicitly
    // enabled. Without this the flag is accepted silently and nothing loads, which is what
    // chrome://extensions-internals proved: only 3 COMPONENT extensions, ours absent.
    '--enable-unsafe-extension-debugging',
    '--disable-extensions-except=' + EXT,
    '--load-extension=' + EXT,
    '--no-first-run',
    '--no-default-browser-check',
  ],
})
log('  chrome up')

const page = ctx.pages()[0] || await ctx.newPage()

// What command line did Chrome actually receive?
await page.goto('chrome://version', { timeout: 15000 }).catch((e) => log('  chrome://version failed: ' + e.message))
await page.waitForTimeout(1200)
const cmdline = await page.evaluate(() => {
  const el = document.getElementById('command_line')
  return el ? el.textContent : '(no command_line element)'
}).catch((e) => '(evaluate blocked: ' + e.message.slice(0, 60) + ')')
log('\n  COMMAND LINE Chrome received:')
log('  ' + String(cmdline).replace(/\s+--/g, '\n    --').slice(0, 1400))
await page.screenshot({ path: path.join(OUT, 'probe-chrome-version.png') })

// Ground truth. chrome://extensions-internals is a plain JSON dump of every installed
// extension, so it does not need shadow DOM spelunking like chrome://extensions does.
await page.goto('chrome://extensions-internals', { timeout: 15000 })
  .catch((e) => log('  extensions-internals failed: ' + e.message))
await page.waitForTimeout(1500)
const dump = await page.evaluate(() => document.body.innerText).catch((e) => '')
fs.writeFileSync(path.join(OUT, 'extensions-internals.json'), dump || '(empty)')
log('\n  extensions-internals: ' + (dump ? dump.length + ' chars' : 'EMPTY'))

const found = []
try {
  const parsed = JSON.parse(dump)
  const list = Array.isArray(parsed) ? parsed : (parsed.extensions || [])
  for (const e of list) {
    const id = e.id || (e.manifest && e.manifest.id)
    const name = (e.manifest && e.manifest.name) || e.name || '?'
    const loc = e.location || (e.path ? 'unpacked' : '?')
    log('    ' + id + '  ' + name + '  [' + loc + ']' + (e.path ? '  ' + e.path : ''))
    if (id) found.push(id)
  }
} catch (e) {
  log('    could not parse the dump: ' + e.message)
  log('    first 300 chars: ' + String(dump).slice(0, 300))
}

await page.goto('chrome://extensions', { timeout: 15000 }).catch(() => {})
await page.waitForTimeout(1500)
await page.screenshot({ path: path.join(OUT, 'probe-chrome-extensions.png') })
log('  screenshot: evidence/probe-chrome-extensions.png')

log('  serviceWorkers seen by playwright: ' + ctx.serviceWorkers().length)

// If we got a real id, try opening the panel with it.
for (const id of found) {
  if (!/^[a-p]{32}$/.test(id)) continue
  const r = await page.goto('chrome-extension://' + id + '/panel/panel.html', { timeout: 8000 })
    .catch((e) => { log('  panel via ' + id + ': ' + String(e.message).split('\n')[0].slice(0, 70)); return null })
  if (r) {
    const n = await page.locator('#goal').count().catch(() => 0)
    log('  panel via ' + id + ': loaded, goalField=' + n)
    if (n) {
      await page.screenshot({ path: path.join(OUT, 'probe-panel.png') })
      log('  screenshot: evidence/probe-panel.png')
      fs.writeFileSync(path.join(OUT, 'extension-id.txt'), id)
      log('\n  REAL EXTENSION ID: ' + id + '  (saved to evidence/extension-id.txt)')
    }
  }
}

await ctx.close()
try { fs.rmSync(dir, { recursive: true, force: true }) } catch {}
log('\ndone')
process.exit(0)
