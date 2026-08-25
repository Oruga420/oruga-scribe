/**
 * test/narrate-isolation.mjs
 *
 * Proves the /narrate route never mixes two recordings.
 *
 * This is the test for the cross tenant leak: narration state used to be two module
 * globals (`inFlight` and `mergeBuffer`) with no session key. Correct for exactly one
 * user, and a data leak for any more: user B's steps went into the shared buffer and were
 * drained into user A's in flight call, so B's page titles, URLs and click labels landed
 * in A's document. B got only "202 merged" and never saw his own narration. Both returned
 * 200 and nothing was logged, which is this project's signature failure shape.
 *
 * Run:  node test/narrate-isolation.mjs
 *
 * To confirm this test can actually fail, revert relay/server.js to a single shared
 * `inFlight` / `mergeBuffer` pair and run it again. Assertion 2 must go red.
 */

import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(import.meta.url)

const PORT = Number(process.env.SCRIBE_PORT || 8795)
process.env.SCRIBE_PORT = String(PORT)

let passed = 0
let failed = 0
const ok = (cond, name, detail) => {
  if (cond) { passed++; console.log('  PASS  ' + name) }
  else { failed++; console.log('  FAIL  ' + name + (detail ? '\n          ' + detail : '')) }
}

// --- stub claude.js before server.js requires it ----------------------------
// The route is what is under test, not the model call. The stub records exactly which
// payload each spawn received, which is where a leak would show up.

const seen = []            // { profile, text }
const releases = []        // one per spawn: each call is held open independently
const releaseAll = () => { while (releases.length) releases.pop()() }

const claudePath = require.resolve(path.join(ROOT, 'relay', 'claude.js'))
require.cache[claudePath] = {
  id: claudePath,
  filename: claudePath,
  loaded: true,
  exports: {
    resolveExe: () => 'stub.exe',
    configDir: () => path.join(ROOT, 'relay', '.claude-home'),
    isLoggedIn: () => true,
    buildUserMessage: (text) => ({ text }),
    run: (profile, payload, opts = {}) => {
      seen.push({ profile, text: payload && payload.text })
      // Emit one delta so the response headers actually reach the client.
      // res.writeHead() only buffers: Node does not flush headers to the socket until the
      // first write(). Without this the fetch never resolves, which looks like a hang and
      // is really just a stalled stream. Worth knowing: a wedged model call gives the panel
      // no headers at all, not even a status.
      setTimeout(() => { try { opts.onDelta && opts.onDelta('.') } catch { /* closed */ } }, 20)
      return new Promise((resolve) => {
        releases.push(() => resolve({ text: 'narrated', usage: {}, timing: {}, model: 'stub' }))
      })
    },
  },
}

require(path.join(ROOT, 'relay', 'server.js'))
await new Promise((r) => setTimeout(r, 400))

const BASE = 'http://127.0.0.1:' + PORT
const post = (body) => fetch(BASE + '/narrate', {
  method: 'POST',
  headers: { 'content-type': 'application/json', origin: 'chrome-extension://test' },
  body: JSON.stringify(body),
})

const step = (name) => ([{ type: 'click', target: { name }, url: 'https://x.test/' + name }])

console.log('\nnarrate isolation\n' + '='.repeat(62))

// --- 1. a missing session id is refused, not bucketed together --------------
{
  const r = await post({ goal: 'g', steps: step('NOSESSION') })
  const j = await r.json()
  ok(r.status === 400 && !j.ok, '1  a request without a sessionId is refused',
    'got ' + r.status + ' ' + JSON.stringify(j).slice(0, 90))
}

// --- 2. THE LEAK. Two sessions must never share a merge buffer --------------
{
  seen.length = 0
  // A starts and stays in flight (the stub holds it open).
  const aDone = post({ goal: 'A', sessionId: 'sess-A', steps: step('AAAA') })
  await new Promise((r) => setTimeout(r, 250))

  // B arrives while A is still running. With the old shared globals, B's steps were
  // pushed into the one merge buffer and drained into A's call.
  const bRes = await post({ goal: 'B', sessionId: 'sess-B', steps: step('BBBB') })

  // A merged call answers 202 with JSON. A call that gets its own flight answers 200 with
  // an NDJSON stream, so status is the honest signal: parsing JSON here would hang on the
  // stream and look like a failure that is really a test bug.
  ok(bRes.status === 200, '2b session B was not swallowed as a merge into A',
    bRes.status === 202 ? 'B got 202 merged against a DIFFERENT session' : 'got ' + bRes.status)

  const aPayload = seen.find((x) => x.text && x.text.includes('AAAA'))
  const leaked = !!(aPayload && aPayload.text.includes('BBBB'))
  ok(!leaked, '2  session B steps never appear in session A payload',
    leaked ? 'LEAK: session A prompt contained BBBB' : '')

  releaseAll()
  await Promise.allSettled([aDone.then((r) => r.text()), bRes.text()])
  await new Promise((r) => setTimeout(r, 200))

  // 2c is the assertion that actually proves the data leak, and it is the one that matters.
  // With shared globals, B's steps sit in the one merge buffer and are drained by session
  // A's NEXT call, not the one already in flight. So a test that only checks A's first
  // payload passes against the bug. This fires a second call for A and looks for B's
  // sentinel in it.
  seen.length = 0
  const a2 = post({ goal: 'A', sessionId: 'sess-A', steps: step('AAAA2') })
  await new Promise((r) => setTimeout(r, 250))
  const a2Payload = seen.find((x) => x.text && x.text.includes('AAAA2'))
  const drained = !!(a2Payload && a2Payload.text.includes('BBBB'))
  ok(!drained, '2c session A\'s NEXT call never drains session B\'s steps',
    drained ? 'LEAK: session A second prompt contained BBBB' : '')
  releaseAll()
  await a2.then((r) => r.text()).catch(() => {})
  await new Promise((r) => setTimeout(r, 150))
}

// --- 3. merging still works WITHIN one session -----------------------------
{
  seen.length = 0
  const first = post({ goal: 'C', sessionId: 'sess-C', steps: step('CCCC') })
  await new Promise((r) => setTimeout(r, 250))
  const second = await post({ goal: 'C', sessionId: 'sess-C', steps: step('CCCC2') })
  const j = await second.json()
  ok(j.merged === true && j.sessionId === 'sess-C',
    '3  two calls for the SAME session still merge, which is the original design',
    'got ' + JSON.stringify(j).slice(0, 90))
  releaseAll()
  await first.then((r) => r.text()).catch(() => {})
}

console.log('\n' + '='.repeat(62))
console.log('  ' + passed + ' passed, ' + failed + ' failed\n')
process.exit(failed ? 1 : 0)
