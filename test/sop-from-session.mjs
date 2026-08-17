/**
 * test/sop-from-session.mjs - write a SOP from a recorded session, through the real relay.
 *
 *   node test/sop-from-session.mjs [session.json]
 *
 * With no argument it uses the session Alejandro actually recorded in Chrome on 2026-08-17:
 * one navigate step to the Delphi web proxy. That is genuinely all the extension captured,
 * because Delphi sits behind IAP and the page redirected to Google sign-in before there was
 * anything else to click. The SOP is therefore short. It is not padded.
 */

import fs from 'node:fs'
import path from 'node:path'

const RELAY = process.env.RELAY || 'http://127.0.0.1:8787'
const ROOT = path.join(import.meta.dirname, '..')

/** Exactly what the panel showed: step 1, "Go to delphi-web-proxy-...". */
const recorded = {
  id: 'rec-2026-08-17-delphi',
  goal: 'Open Delphi and get to the point where I can use it',
  company: 'personal',
  startedAt: '2026-08-17T00:00:00.000Z',
  endedAt: '2026-08-17T00:01:00.000Z',
  originAllowlist: ['https://delphi-web-proxy-11570296898.us-central1.run.app'],
  paused: false,
  pauseReason: '',
  steps: [
    {
      id: 's1', type: 'navigate', seq: 1, at: '2026-08-17T00:00:05.000Z',
      pageTitle: '',
      url: 'https://delphi-web-proxy-11570296898.us-central1.run.app/',
      section: '',
      target: { role: '', name: 'https://delphi-web-proxy-11570296898.us-central1.run.app/', tag: '', text: '', testId: '', bbox: null, inShadow: false, inIframe: false },
      selectors: [], field: null, beforeFrame: null, afterFrame: null,
      signal: 'normal',
      note: 'The site is behind Google IAP. Landing here redirects to a Google sign-in screen before any of the app is reachable.',
      narration: '', pruned: false,
    },
  ],
}

const file = process.argv[2]
const session = file ? JSON.parse(fs.readFileSync(file, 'utf8')) : recorded

console.log('\nwriting a SOP through the relay')
console.log('  relay   ' + RELAY)
console.log('  goal    ' + session.goal)
console.log('  steps   ' + session.steps.length + (file ? '  (from ' + file + ')' : '  (as recorded in Chrome)'))
console.log('')

let health
try {
  health = await (await fetch(RELAY + '/health', { headers: { origin: 'chrome-extension://probe' } })).json()
} catch (e) {
  console.error('  the relay is not answering: ' + e.message)
  console.error('  start it with: start-relay.bat            (isolated personal login)')
  console.error('              or start-relay.bat promise    (machine default login)')
  process.exit(2)
}
console.log('  relay ok, loggedIn=' + health.loggedIn + ', configDir=' + health.configDir)
if (!health.loggedIn) {
  console.error('\n  Not logged in, so the writer cannot run. See relay/README-auth.md.')
  process.exit(2)
}

const t0 = Date.now()
const res = await fetch(RELAY + '/synthesize', {
  method: 'POST',
  headers: { 'content-type': 'application/json', origin: 'chrome-extension://probe' },
  body: JSON.stringify({ session }),
})
const out = await res.json()

if (!out.ok) {
  console.error('\n  relay refused: ' + out.error)
  process.exit(1)
}

console.log('  wrote in ' + (Date.now() - t0) + 'ms')
console.log('  model    ' + (out.model || []).join(','))
console.log('  usage    ' + JSON.stringify(out.usage && {
  input: out.usage.input_tokens,
  cache_read: out.usage.cache_read_input_tokens,
  output: out.usage.output_tokens,
}))
if (out.rateLimit) console.log('  quota    ' + out.rateLimit.rateLimitType + ' / ' + out.rateLimit.status)
console.log('  saved to ' + out.dir)
console.log('\n' + '='.repeat(70))
console.log(out.markdown)
console.log('='.repeat(70) + '\n')

// Also drop a copy where evidence lives, so it is easy to find.
const ev = path.join(ROOT, 'evidence')
fs.mkdirSync(ev, { recursive: true })
fs.writeFileSync(path.join(ev, 'SOP-delphi.md'), out.markdown)
console.log('  copy at evidence/SOP-delphi.md\n')
