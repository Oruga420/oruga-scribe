/**
 * test/probe-launch.mjs - which Playwright launch path actually works on this machine?
 *
 * The evidence run hung in launchPersistentContext with no output, so bisect the launch
 * options instead of guessing: system Chrome versus bundled Chromium, headed versus headless,
 * with and without the extension.
 */

import path from 'node:path'
import os from 'node:os'
import { pathToFileURL } from 'node:url'

const ROOT = path.join(import.meta.dirname, '..')
const EXT = path.join(ROOT, 'extension')
const { chromium } = await import(
  pathToFileURL(path.join(ROOT, '.tools', 'node_modules', 'playwright', 'index.mjs')).href)

let n = 0
async function attempt(label, opts) {
  const dir = path.join(os.tmpdir(), 'oruga-probe-' + process.pid + '-' + (++n))
  process.stdout.write('  ' + label.padEnd(42) + ' ... ')
  const t = Date.now()
  let ctx = null
  try {
    ctx = await Promise.race([
      chromium.launchPersistentContext(dir, opts),
      new Promise((_, rej) => setTimeout(() => rej(new Error('TIMEOUT after 40s')), 40_000)),
    ])
    const pages = ctx.pages().length
    // Give an MV3 worker a moment to register.
    await new Promise((r) => setTimeout(r, 3000))
    const sws = ctx.serviceWorkers().length
    process.stdout.write('OK ' + (Date.now() - t) + 'ms  pages=' + pages + ' serviceWorkers=' + sws + '\n')
    return true
  } catch (e) {
    process.stdout.write('FAIL  ' + String(e.message).split('\n')[0].slice(0, 100) +
      '  (' + (Date.now() - t) + 'ms)\n')
    return false
  } finally {
    if (ctx) { try { await ctx.close() } catch { /* ignore */ } }
  }
}

const withExt = ['--disable-extensions-except=' + EXT, '--load-extension=' + EXT,
  '--no-first-run', '--no-default-browser-check']

console.log('\nprobing playwright launch paths')
console.log('  extension: ' + EXT + '\n')

await attempt('system chrome, headless, no ext', { channel: 'chrome', headless: true })
await attempt('system chrome, headed, no ext', { channel: 'chrome', headless: false })
await attempt('bundled chromium, headed, no ext', { headless: false })
await attempt('bundled chromium, headed, WITH ext', { headless: false, args: withExt })
await attempt('bundled chromium, headless, WITH ext', { headless: true, args: withExt })
await attempt('system chrome, headed, WITH ext', { channel: 'chrome', headless: false, args: withExt })

console.log('')
process.exit(0)
