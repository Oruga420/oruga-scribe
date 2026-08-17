/**
 * test/harness.mjs - the contract checker.
 *
 *   node test/harness.mjs
 *
 * Verifies criteria A, C and D from CONTRACT.md. B and E need a human or a login.
 * The important one is A2: it kills and revives the service worker mid recording, which is
 * the failure that made the first real load do nothing.
 */

import { makeChrome, tick, TINY_JPEG_DATA_URL, canvasFills } from './fake-chrome.mjs'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import path from 'node:path'

const require = createRequire(import.meta.url)
const ROOT = path.join(import.meta.dirname, '..')

let pass = 0, fail = 0
const failures = []

function ok(id, name) { pass++; console.log('  PASS  ' + id + '  ' + name) }
function bad(id, name, why) {
  fail++
  failures.push(id + ' ' + name + ': ' + why)
  console.log('  FAIL  ' + id + '  ' + name + '\n        ' + why)
}
function assert(id, name, cond, why) { cond ? ok(id, name) : bad(id, name, why || 'assertion failed') }

// --- environment ------------------------------------------------------------

/**
 * Load sw.js against a fake Chrome. `bust` forces a fresh module instance, which is how a
 * worker revival is simulated: new module globals, same storage.
 */
async function loadWorker(env, bust) {
  globalThis.chrome = env.chrome
  const url = pathToFileURL(path.join(ROOT, 'extension', 'sw.js')).href + '?v=' + bust
  env.listeners.message.length = 0
  env.listeners.navCommitted.length = 0
  await import(url)
  await tick()
}

/** Minimal indexedDB and canvas so sw.js can run outside a browser. */
async function installBrowserShims() {
  const { default: FDBFactory } = await tryImport('fake-indexeddb/lib/FDBFactory.js')
  if (FDBFactory) {
    globalThis.indexedDB = new FDBFactory()
  } else {
    globalThis.indexedDB = makeMemoryIndexedDb()
  }

  // OffscreenCanvas and createImageBitmap: sw.js uses them for crop, diff and the aspect
  // guard. Node has no canvas, so stub the pixel work but keep the SHAPES honest, including
  // the aspect ratio numbers, because the guard is a contract criterion.
  globalThis.createImageBitmap = async (blobOrBmp) => {
    if (blobOrBmp && blobOrBmp.__bmp) return blobOrBmp
    const size = globalThis.__fakeImageSize || { width: 1280, height: 800 }
    return { width: size.width, height: size.height, close() {}, __bmp: true }
  }
  globalThis.OffscreenCanvas = class {
    constructor(w, h) { this.width = w; this.height = h }
    getContext() {
      const self = this
      return {
        fillStyle: '', strokeStyle: '', lineWidth: 1, filter: 'none',
        _fills: (self._fills = []),
        drawImage() {},
        fillRect(x, y, w, h) {
          const rec = { x, y, w, h, style: this.fillStyle, filter: this.filter }
          self._fills.push(rec)
          canvasFills.push(rec)   // shared, because the fill lands on an intermediate canvas
        },
        strokeRect() {},
        getImageData: (x, y, w, h) => ({ data: new Uint8ClampedArray(w * h * 4) }),
      }
    }
    transferToImageBitmap() { return { width: this.width, height: this.height, close() {}, __bmp: true, _fills: this._fills } }
    async convertToBlob() {
      const b = new Blob([new Uint8Array(64)], { type: 'image/webp' })
      b.__fills = this._fills
      b.__w = this.width
      b.__h = this.height
      return b
    }
  }
  if (!globalThis.fetch) throw new Error('node 18+ required for fetch')
}

async function tryImport(spec) {
  try { return await import(spec) } catch { return { default: null } }
}

/** A tiny in-memory IndexedDB, enough for get/put/delete/count/getAll on two stores. */
function makeMemoryIndexedDb() {
  const dbs = new Map()
  return {
    open(name) {
      const req = {}
      setTimeout(() => {
        if (!dbs.has(name)) {
          dbs.set(name, { stores: new Map() })
          req.result = wrap(dbs.get(name))
          req.transaction = { objectStore: (n) => storeOf(dbs.get(name), n) }
          if (req.onupgradeneeded) req.onupgradeneeded()
        }
        req.result = wrap(dbs.get(name))
        if (req.onsuccess) req.onsuccess()
      }, 0)
      return req
    },
  }

  function storeOf(db, n) {
    if (!db.stores.has(n)) db.stores.set(n, new Map())
    const m = db.stores.get(n)
    return {
      put(v, k) { m.set(k !== undefined ? k : v.id, v); return { result: k } },
      get(k) { return { result: m.get(k) } },
      delete(k) { m.delete(k); return { result: undefined } },
      count() { return { result: m.size } },
      getAll() { return { result: [...m.values()] } },
    }
  }
  function wrap(db) {
    return {
      objectStoreNames: { contains: (n) => db.stores.has(n) },
      createObjectStore(n) { db.stores.set(n, new Map()); return storeOf(db, n) },
      transaction(name) {
        const t = {}
        const s = storeOf(db, name)
        setTimeout(() => { if (t.oncomplete) t.oncomplete() }, 0)
        return Object.assign(t, { objectStore: () => s })
      },
    }
  }
}

// --- step fixtures ----------------------------------------------------------

function pointerdownMsg(seq, over = {}) {
  return {
    from: 'oruga-capture',
    kind: 'pointerdown',
    step: Object.assign({
      seq, type: 'click',
      pageTitle: 'App Credentials',
      url: 'https://api.slack.com/apps/A1/oauth?token=SECRET123',
      section: 'OAuth Tokens',
      target: {
        role: 'button', name: 'Regenerate', tag: 'button', text: 'Regenerate',
        testId: '', bbox: { x: 100, y: 200, width: 90, height: 32 },
        inShadow: false, inIframe: false,
      },
      selectors: [{ kind: 'role+name', value: 'button[name="Regenerate"]' }],
      dpr: 1,
      redactRects: [],
      viewport: { w: 1280, h: 800 },
    }, over),
  }
}

const SENDER = { tab: { id: 7, windowId: 1 } }

// --- the run ----------------------------------------------------------------

console.log('\noruga-scribe contract harness\n' + '='.repeat(62) + '\n')
await installBrowserShims()

// ===== A. recording survives the worker =====
console.log('A. RECORDING SURVIVES THE SERVICE WORKER')

const env = makeChrome()
await loadWorker(env, 'a1')

const started = await env.deliver({ to: 'oruga-sw', kind: 'start', goal: 'rotate the slack token', company: 'personal' })
assert('A0', 'start returns a session', started && started.ok && started.session && started.session.id,
  'start returned ' + JSON.stringify(started))
const sessionId = started && started.session && started.session.id

await env.deliver(pointerdownMsg(1), SENDER)
await env.deliver({ from: 'oruga-capture', kind: 'settled', seq: 1, why: 'quiet', redactRects: [] }, SENDER)
for (let i = 0; i < 60; i++) await tick()

let got = await env.deliver({ to: 'oruga-sw', kind: 'getSession', sessionId })
assert('A1', 'a step is captured right after record',
  got && got.session && got.session.steps.length === 1,
  'steps = ' + JSON.stringify(got && got.session && got.session.steps.length))

// KILL THE WORKER. New module instance, globals gone, storage.session preserved.
// This is what Chrome does after 30 seconds idle and it is what broke the first real run.
await loadWorker(env, 'a2-revived')

await env.deliver(pointerdownMsg(2), SENDER)
await env.deliver({ from: 'oruga-capture', kind: 'settled', seq: 2, why: 'quiet', redactRects: [] }, SENDER)
for (let i = 0; i < 60; i++) await tick()

got = await env.deliver({ to: 'oruga-sw', kind: 'getSession', sessionId })
assert('A2', 'a step is STILL captured after the worker was killed and revived',
  got && got.session && got.session.steps.length === 2,
  'after revival steps = ' + (got && got.session ? got.session.steps.length : 'no session') +
  '. This is the bug that made record do nothing.')

assert('A3', 'the live pointer lives in storage.session, not a module global',
  env.sessionStore.has('live'),
  'storage.session has no "live" key, so the pointer is still in memory')

const panelStepMsgs = env.log.panelMessages.filter((m) => m.kind === 'step')
assert('A4', 'the panel is told only after the step is persisted',
  panelStepMsgs.length >= 2 && got.session.steps.length >= panelStepMsgs.length - 1,
  'panel got ' + panelStepMsgs.length + ' step messages, disk has ' + got.session.steps.length)

// ===== A5/A6. the toolbar button actually opens the panel =====
// Regression: setPanelBehavior was only called inside onInstalled, which does NOT fire when
// you reload an unpacked extension or restart the browser. It worked once on fresh install and
// then the button did nothing, which reads as "the extension stopped opening".
const envP = makeChrome()
await loadWorker(envP, 'panel1')   // a plain worker wake: no onInstalled, no onStartup
assert('A5', 'panel behavior is wired on every worker start, not only on install',
  envP.log.panelBehavior.length > 0 && envP.log.panelBehavior[0].openPanelOnActionClick === true,
  'setPanelBehavior was never called on a plain worker wake. The toolbar button will do nothing '
  + 'after any extension reload.')

await envP.clickAction()
assert('A6', 'clicking the toolbar button opens the panel explicitly as a fallback',
  envP.log.panelOpens.length > 0,
  'action.onClicked did not open the side panel, so there is no fallback if the behavior flag is ignored')

// ===== B. attaching =====
console.log('\nB. ATTACHING TO A TAB THAT IS ALREADY OPEN')

const env2 = makeChrome()
env2.state.contentScriptPresent = false     // tab was open before the extension loaded
await loadWorker(env2, 'b1')
const s2 = await env2.deliver({ to: 'oruga-sw', kind: 'start', goal: 'document the thing', company: 'personal' })
assert('B1', 'start injects the content script instead of demanding a reload',
  env2.log.injected.length > 0 && env2.log.injected[0].files.includes('content/capture.js'),
  'executeScript was never called, so an already-open tab silently records nothing')
assert('B1b', 'and start then reports frames reached',
  s2 && s2.framesReached > 0, 'framesReached = ' + (s2 && s2.framesReached))

// navigation mid recording must not end the session
const before = env2.log.panelMessages.filter((m) => m.kind === 'step').length
await env2.navigate('https://api.slack.com/apps/A1/general')
for (let i = 0; i < 40; i++) await tick()
await env2.deliver(pointerdownMsg(9), { tab: { id: 7, windowId: 1 } })
await env2.deliver({ from: 'oruga-capture', kind: 'settled', seq: 9, why: 'quiet', redactRects: [] }, { tab: { id: 7, windowId: 1 } })
for (let i = 0; i < 60; i++) await tick()
const after = env2.log.panelMessages.filter((m) => m.kind === 'step').length
assert('B4', 'recording continues across a navigation',
  after > before, 'no steps recorded after navigating; steps before=' + before + ' after=' + after)

// hello handshake: a fresh document must be told to keep recording
const hello = await env2.deliver({ from: 'oruga-capture', kind: 'hello', url: 'x', top: true }, { tab: { id: 7, windowId: 1 } })
assert('B5', 'a fresh document asking "am I recording?" is told yes',
  hello && hello.recording === true, 'hello replied ' + JSON.stringify(hello))

// restricted page refused
const env3 = makeChrome()
env3.state.tabs[0].url = 'chrome://extensions'
await loadWorker(env3, 'b3')
const r3 = await env3.deliver({ to: 'oruga-sw', kind: 'start', goal: 'try a restricted page', company: 'personal' })
assert('B3', 'a restricted page is refused with a reason',
  r3 && r3.ok === false && /cannot record/i.test(r3.error || ''),
  'got ' + JSON.stringify(r3))

// ===== C. review =====
console.log('\nC. THE REVIEW SHOWS WHAT WAS RECORDED')

const stopped = await env.deliver({ to: 'oruga-sw', kind: 'stop' })
assert('C1', 'stop returns the session with its steps',
  stopped && stopped.session && stopped.session.steps.length === 2,
  'stop returned ' + JSON.stringify(stopped && stopped.session && stopped.session.steps.length))
assert('C1b', 'and marks it ended',
  !!(stopped && stopped.session && stopped.session.endedAt), 'endedAt missing')

const firstStepId = stopped && stopped.session && stopped.session.steps[0] && stopped.session.steps[0].id
await env.deliver({ to: 'oruga-sw', kind: 'updateStep', sessionId, step: { id: firstStepId, pruned: true } })
const afterPrune = await env.deliver({ to: 'oruga-sw', kind: 'getSession', sessionId })
assert('C3', 'a pruned step is persisted as pruned',
  !!(afterPrune && afterPrune.session && afterPrune.session.steps[0].pruned === true),
  'prune did not stick')

const frameKey = stopped && stopped.session && stopped.session.steps[0] && stopped.session.steps[0].beforeFrame
const frame = frameKey ? await env.deliver({ to: 'oruga-sw', kind: 'getFrame', key: frameKey }) : null
assert('C2', 'a screenshot is stored and retrievable as base64 for the panel',
  frame && frame.ok && typeof frame.base64 === 'string' && frame.base64.length > 0,
  'getFrame returned ' + JSON.stringify(frame && frame.ok))

// ===== D. nothing leaks =====
console.log('\nD. NOTHING LEAKS')

const scrub = require(path.join(ROOT, 'relay', 'scrub.js'))

const payload = scrub.scrubPayload({
  goal: 'rotate the token',
  steps: [
    { type: 'change', pageTitle: 'Login', url: 'https://x.com/?access_token=abc123',
      target: { role: 'textbox', name: 'Password' },
      field: { type: 'password', label: 'Password', filled: true, secret: true, value: 'hunter2' } },
    { type: 'click', pageTitle: 'Keys', url: 'https://x.com/k',
      target: { role: 'button', name: 'copy sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAA' } },
  ],
})
const flat = JSON.stringify(payload)
assert('D1', 'a password value never reaches the payload',
  !flat.includes('hunter2'), 'the literal password survived into ' + flat)
assert('D1b', 'a secret field is labelled as secret, not by its name',
  payload.steps[0].field.label === '[secret field]', 'label = ' + payload.steps[0].field.label)
assert('D2', 'an api key in a label is redacted',
  !flat.includes('sk-ant-api03'), 'key survived')
assert('D2b', 'a token in a url is redacted',
  !flat.includes('abc123'), 'url token survived')

let dropped = false
try {
  scrub.scrubPayload({ goal: 'x' })   // no steps: must throw, and the caller drops
} catch { dropped = true }
assert('D4', 'a payload the scrubber cannot process throws so the caller drops it',
  dropped, 'scrubPayload accepted a malformed payload instead of throwing')

// D3: the model frame must be blacked out with a solid fill, never a blur
const shot = await import(pathToFileURL(path.join(ROOT, 'extension', 'lib', 'shot.js')).href)
globalThis.__fakeImageSize = { width: 1280, height: 800 }
canvasFills.length = 0
await shot.toModelFrame(TINY_JPEG_DATA_URL,
  { x: 100, y: 200, width: 90, height: 32 },
  [{ x: 300, y: 400, width: 200, height: 24 }], 1)
assert('D3', 'flagged regions are painted with a solid black fill',
  canvasFills.length === 1 && canvasFills[0].style === '#000',
  'fills = ' + JSON.stringify(canvasFills))
assert('D3b', 'and never with a blur filter, which is partially reversible over text',
  canvasFills.every((f) => !f.filter || f.filter === 'none'),
  'a fill used filter ' + JSON.stringify(canvasFills.map((f) => f.filter)))

// the aspect guard, which stops the model from confidently misreading a squeezed frame
globalThis.__fakeImageSize = { width: 1280, height: 5000 }
let guarded = false
try {
  await shot.toModelFrame(TINY_JPEG_DATA_URL, null, [], 1)
} catch (e) { guarded = e.name === 'AspectGuardError' }
assert('D5', 'a tall frame is refused by the aspect guard',
  guarded, 'a 1280x5000 frame was accepted; the model would have misread it while reporting success')
globalThis.__fakeImageSize = { width: 1280, height: 800 }

// --- report -----------------------------------------------------------------

console.log('\n' + '='.repeat(62))
console.log('  ' + pass + ' passed, ' + fail + ' failed')
if (fail) {
  console.log('\n  Unmet contract items:')
  for (const f of failures) console.log('   - ' + f)
}
console.log('')
process.exit(fail ? 1 : 0)
