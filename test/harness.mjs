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
import fs from 'node:fs'

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
  const url = pathToFileURL(path.join(ROOT, 'apps', 'extension', 'sw.js')).href + '?v=' + bust
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

/**
 * Deterministic latency injected into the fake store, in macrotask ticks.
 *
 * Without this the fake resolves so fast that a read-modify-write window never interleaves, so
 * the concurrency test passed even with the racy implementation deliberately restored. A test
 * that cannot fail is worse than no test, because it reads as coverage.
 *
 * Reads are made slower than writes so the classic pattern (A reads, B reads, A writes,
 * B writes) actually happens.
 */
let idbDelay = { get: 0, put: 0 }
function setIdbDelay(get, put) { idbDelay = { get, put } }
function ticks(n) {
  let p = Promise.resolve()
  for (let i = 0; i < n; i++) p = p.then(() => new Promise((r) => setTimeout(r, 0)))
  return p
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
    // CLONE on read and on write. Real IndexedDB serializes, so every get hands back a fresh
    // object. Returning the same reference meant concurrent handlers all mutated ONE shared
    // object, so no write could ever be lost and the race was untestable by construction.
    const clone = (v) => {
      if (v == null || typeof v !== 'object') return v
      if (typeof Blob !== 'undefined' && v instanceof Blob) return v   // blobs pass through
      return structuredClone(v)
    }
    return {
      put(v, k) { m.set(k !== undefined ? k : v.id, clone(v)); return { result: k } },
      get(k) { return { result: clone(m.get(k)) } },
      delete(k) { m.delete(k); return { result: undefined } },
      count() { return { result: m.size } },
      getAll() { return { result: [...m.values()].map(clone) } },
      getAllKeys() { return { result: [...m.keys()] } },
    }
  }
  function wrap(db) {
    return {
      objectStoreNames: { contains: (n) => db.stores.has(n) },
      createObjectStore(n) { db.stores.set(n, new Map()); return storeOf(db, n) },
      transaction(name, mode) {
        const t = {}
        const real = storeOf(db, name)
        // Defer the actual mutation until the transaction completes, and complete it after a
        // configurable number of ticks. A write that lands immediately cannot be raced.
        const queued = []
        const s = {
          put(v, k) { queued.push(() => real.put(v, k)); return { result: k } },
          get(k) { return real.get(k) },
          delete(k) { queued.push(() => real.delete(k)); return { result: undefined } },
          count() { return real.count() },
          getAll() { return real.getAll() },
          getAllKeys() { return real.getAllKeys() },
        }
        const delay = mode === 'readwrite' ? idbDelay.put : idbDelay.get
        ticks(delay).then(() => {
          for (const fn of queued) fn()
          if (t.oncomplete) t.oncomplete()
        })
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

// ===== A7. concurrent steps must not clobber each other =====
// Regression: saveStep was a bare read-modify-write with awaits in the middle, so two
// overlapping steps each read the session, each pushed to its own copy, and the second write
// silently destroyed the first. A step vanished with no error anywhere.
const envR = makeChrome()
// Reads slower than writes, so the read-modify-write window is genuinely open. Verified to FAIL
// against the racy implementation, which is the only reason to trust it when it passes.
setIdbDelay(3, 1)
envR.state.captureFails = true   // captures also serialize; take them out of the equation
await loadWorker(envR, 'race1')
const sr = await envR.deliver({ to: 'oruga-sw', kind: 'start', goal: 'hammer it', company: 'personal' })
const rid = sr && sr.session && sr.session.id

// Fire 8 steps with no awaiting between them, the way a fast clicker does.
const SENDER_R = { tab: { id: 7, windowId: 1 } }
const fired = []
for (let i = 1; i <= 8; i++) {
  fired.push(envR.deliver(pointerdownMsg(100 + i), SENDER_R))
}
await Promise.all(fired)
for (let i = 0; i < 600; i++) await tick()

const raced = await envR.deliver({ to: 'oruga-sw', kind: 'getSession', sessionId: rid })
const n = raced && raced.session ? raced.session.steps.length : 0
assert('A7', 'concurrent steps are all persisted, none clobbered',
  n === 8, 'fired 8 overlapping steps, only ' + n + ' survived. Session writes are racing.')

const ids = raced && raced.session ? raced.session.steps.map((s) => s.id) : []
assert('A7b', 'and no step was duplicated',
  new Set(ids).size === ids.length, 'duplicate step ids: ' + JSON.stringify(ids))

// A8 is the one that genuinely proves serialization. Panel writes (prune, note, reorder) have no
// capture scheduler in front of them, so two of them landing together is the real unprotected
// window. Verified to FAIL when updateStep is a bare read-modify-write.
if (ids.length >= 4) {
  await Promise.all([
    envR.deliver({ to: 'oruga-sw', kind: 'updateStep', sessionId: rid, step: { id: ids[0], pruned: true } }),
    envR.deliver({ to: 'oruga-sw', kind: 'updateStep', sessionId: rid, step: { id: ids[1], note: 'second write' } }),
    envR.deliver({ to: 'oruga-sw', kind: 'updateStep', sessionId: rid, step: { id: ids[2], pruned: true } }),
  ])
  for (let i = 0; i < 400; i++) await tick()
  const after = await envR.deliver({ to: 'oruga-sw', kind: 'getSession', sessionId: rid })
  const byId = new Map((after.session ? after.session.steps : []).map((s) => [s.id, s]))
  const kept = [
    byId.get(ids[0]) && byId.get(ids[0]).pruned === true,
    byId.get(ids[1]) && byId.get(ids[1]).note === 'second write',
    byId.get(ids[2]) && byId.get(ids[2]).pruned === true,
  ]
  assert('A8', 'three concurrent panel writes all survive',
    kept.every(Boolean),
    'lost writes: ' + JSON.stringify(kept) + '. Panel edits are clobbering each other.')
}
setIdbDelay(0, 0)

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

// D6: the two scrubUrl kill lists must be identical.
//
// This is a REGRESSION guard for drift that already happened. scrubUrl exists twice, once
// at capture time in the extension and once at the relay gate, and the lists silently
// diverged: the relay redacted `email` and the extension did not. One directory boundary,
// no bundler between them, and the security function this whole tool rests on. Nothing
// caught it because nothing compared them, which is this project's signature failure.
//
// Falsifiability, per the rule adopted after the three test fidelity defects: delete
// `|email` from either file and this assertion must go red.
const KILL_RE = /const kill = \/([^/]+)\/i/
const killIn = (rel) => {
  const src = fs.readFileSync(path.join(ROOT, ...rel), 'utf8')
  const m = src.match(KILL_RE)
  return m ? m[1] : null
}
const killExt = killIn(['apps', 'extension', 'lib', 'schema.js'])
const killRelay = killIn(['relay', 'scrub.js'])
assert('D6', 'both scrubUrl kill lists are identical, so they cannot drift again',
  killExt !== null && killExt === killRelay,
  'extension: ' + killExt + '\n          relay:     ' + killRelay)
assert('D6b', 'and the kill list still covers email, which is what drifted',
  !!killExt && /(^|\|)email(\||$)/.test(killExt),
  'email is missing from ' + killExt)

// D3: the model frame must be blacked out with a solid fill, never a blur
const shot = await import(pathToFileURL(path.join(ROOT, 'apps', 'extension', 'lib', 'shot.js')).href)
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

// ===== E. second pass findings =====
console.log('\nE. SECOND PASS')

// E1: no orphaned image blobs after a purge. modelFrame used to be missed entirely.
const idbMod = await import(pathToFileURL(path.join(ROOT, 'apps', 'extension', 'lib', 'idb.js')).href)
const purgeSess = {
  id: 'purge-test', goal: 'g', company: 'personal', steps: [
    { id: 'p1', beforeFrame: 'p1-b', afterFrame: 'p1-a', modelFrame: 'p1-m' },
    { id: 'p2', beforeFrame: 'p2-b', modelFrame: 'p2-m' },
  ],
}
for (const k of ['p1-b', 'p1-a', 'p1-m', 'p2-b', 'p2-m']) {
  await idbMod.putFrame(k, new Blob([new Uint8Array(8)], { type: 'image/webp' }))
}
await idbMod.putSession(purgeSess)
const beforeCount = await idbMod.frameCount()
await idbMod.purgeSession('purge-test')
const leftovers = []
for (const k of ['p1-b', 'p1-a', 'p1-m', 'p2-b', 'p2-m']) {
  if (await idbMod.getFrame(k)) leftovers.push(k)
}
assert('E1', 'purging a session deletes every frame including modelFrame',
  leftovers.length === 0,
  'leaked ' + JSON.stringify(leftovers) + ' (had ' + beforeCount + ' frames). ' +
  'With unlimitedStorage nothing ever complains, so these accumulate forever.')

// E6: a missing key must read as MISSING, not as a truthy request object.
// This was the nastiest find of the pass. tx() unwrapped an IDBRequest with
// `out.result !== undefined ? out.result : out`, so a missing key returned the request itself,
// and `{result: undefined}` is truthy. `if (!blob)` never fired, `if (!session) throw` never
// fired, and callers went on to read .steps off a request object.
const missingFrame = await idbMod.getFrame('definitely-not-a-key')
assert('E6', 'a missing frame is falsy, not a truthy request object',
  !missingFrame,
  'getFrame returned ' + JSON.stringify(missingFrame) + ' for a key that does not exist, ' +
  'so every "if (!blob)" guard downstream is dead')
const missingSession = await idbMod.getSession('definitely-not-a-session')
assert('E6b', 'a missing session is falsy too',
  !missingSession,
  'getSession returned ' + JSON.stringify(missingSession) + ' for a key that does not exist')

// E2: the dropped-image sentinel must not require an exact match.
const claudeMod = require(path.join(ROOT, 'relay', 'claude.js'))
assert('E2', 'a sentinel with a trailing period is still detected',
  claudeMod.detectImageFailure('NO-IMAGE-RECEIVED.') === true,
  'an exact-match check would miss this, and the step would be narrated blind')
assert('E2b', 'and the CLI phrase is still detected',
  claudeMod.detectImageFailure('API Error: an image in the conversation could not be processed and was removed.') === true,
  'missed the CLI phrase')
assert('E2c', 'without false positives on ordinary narration',
  claudeMod.detectImageFailure('Click Save on the invoice page.') === false,
  'false positive on normal text')

// E3: a company name from the request body must never escape out/.
const srvSrc = fs.readFileSync(path.join(ROOT, 'relay', 'server.js'), 'utf8')
const usesSafeSegment = /path\.join\(OUT_DIR,\s*safeSegment\(/.test(srvSrc)
assert('E3', 'the output directory is built from a sanitized path segment',
  usesSafeSegment,
  'session.company goes straight into path.join, so "../../Windows/Temp" writes outside out/')

// E4: the login check must not spawn a process every few seconds forever.
const claudeSrc = fs.readFileSync(path.join(ROOT, 'relay', 'claude.js'), 'utf8')
assert('E4', 'a positive login result is cached for minutes, not seconds',
  /LOGIN_TTL_OK\s*=\s*\d+\s*\*\s*60_000/.test(claudeSrc),
  'the panel polls /health every 5s; a short flat TTL spawns a claude process forever')

// E5: streaming writes must be guarded against a client that hung up.
assert('E5', 'narration writes check the socket before writing',
  /writableEnded\s*\|\|\s*res\.destroyed/.test(srvSrc),
  'res.write on a closed socket throws, and the panel closes mid narration routinely')
assert('E5b', 'and a client disconnect aborts the model call',
  /signal:\s*abort\.signal/.test(srvSrc),
  'a closed panel would keep burning quota on narration nobody will read')

// --- report -----------------------------------------------------------------

console.log('\n' + '='.repeat(62))
console.log('  ' + pass + ' passed, ' + fail + ' failed')
if (fail) {
  console.log('\n  Unmet contract items:')
  for (const f of failures) console.log('   - ' + f)
}
console.log('')
process.exit(fail ? 1 : 0)
