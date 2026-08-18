/**
 * test/sop-from-session.mjs - write a SOP from a recorded session, through the real relay.
 *
 *   node test/sop-from-session.mjs [session.json]
 *
 * With no argument it uses a small built in fixture, which is enough to exercise the writer end
 * to end. Point it at an evidence/session.json to turn a real recording into a real SOP.
 */

import fs from 'node:fs'
import path from 'node:path'

const RELAY = process.env.RELAY || 'http://127.0.0.1:8787'
const ROOT = path.join(import.meta.dirname, '..')

/**
 * A minimal two step fixture, so running this with no arguments still exercises the whole
 * writer path. Pass your own session.json to write a SOP from a real recording:
 *   node test/sop-from-session.mjs evidence/session.json
 */
const recorded = {
  id: 'rec-fixture',
  goal: 'Rotate an API token in an admin console',
  company: 'personal',
  startedAt: '2026-01-01T00:00:00.000Z',
  endedAt: '2026-01-01T00:01:00.000Z',
  originAllowlist: ['https://example.com'],
  paused: false,
  pauseReason: '',
  steps: [
    {
      id: 's1', type: 'navigate', seq: 1, at: '2026-01-01T00:00:05.000Z',
      pageTitle: '', url: 'https://example.com/settings/credentials', section: '',
      target: { role: '', name: 'https://example.com/settings/credentials', tag: '', text: '', testId: '', bbox: null, inShadow: false, inIframe: false },
      selectors: [], field: null, beforeFrame: null, afterFrame: null,
      signal: 'normal',
      note: 'Requires being signed in already.',
      narration: '', pruned: false,
    },
    {
      id: 's2', type: 'click', seq: 2, at: '2026-01-01T00:00:20.000Z',
      pageTitle: 'Credentials', url: 'https://example.com/settings/credentials',
      section: 'API tokens',
      target: { role: 'button', name: 'Regenerate', tag: 'button', text: 'Regenerate', testId: '', bbox: { x: 100, y: 200, width: 90, height: 32 }, inShadow: false, inIframe: false },
      selectors: [{ kind: 'role+name', value: 'button[name="Regenerate"]' }],
      field: null, beforeFrame: 's2-before', afterFrame: null,
      signal: 'normal', note: '', narration: '', pruned: false,
    },
  ],
}

const file = process.argv[2]
const session = file ? JSON.parse(fs.readFileSync(file, 'utf8')) : recorded

console.log('\nwriting a SOP through the relay')
console.log('  relay   ' + RELAY)
console.log('  goal    ' + session.goal)
console.log('  steps   ' + session.steps.length + (file ? '  (from ' + file + ')' : '  (built in fixture)'))
console.log('')

let health
try {
  health = await (await fetch(RELAY + '/health', { headers: { origin: 'chrome-extension://probe' } })).json()
} catch (e) {
  console.error('  the relay is not answering: ' + e.message)
  console.error('  start it with: start-relay.bat         (isolated personal login)')
  console.error('              or start-relay.bat work    (machine default login)')
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
fs.writeFileSync(path.join(ev, 'SOP.md'), out.markdown)
console.log('  copy at evidence/SOP.md\n')
