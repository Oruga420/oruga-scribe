/**
 * Service worker. Deliberately thin.
 *
 * It does NOT own the session. It terminates after 30s idle and loses every global, and
 * an open side panel does not keep it alive. So: the panel owns state, this routes events
 * and captures pixels, and every step is written to IndexedDB before it is acknowledged.
 */

import { makeStep, makeSession, STEP_TYPES, SIGNAL, scrubUrl } from './lib/schema.js'
import * as idb from './lib/idb.js'
import * as shot from './lib/shot.js'

// --- capture scheduler ------------------------------------------------------

/**
 * MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND is 2. Exceeding it rejects the call.
 * Everything funnels through here so a fast clicker degrades a frame instead of
 * throwing away a step.
 */
const MIN_GAP_MS = 550
let lastCaptureAt = 0
let captureChain = Promise.resolve()

function scheduleCapture(windowId) {
  const run = async () => {
    const wait = MIN_GAP_MS - (Date.now() - lastCaptureAt)
    if (wait > 0) await new Promise((r) => setTimeout(r, wait))
    lastCaptureAt = Date.now()
    try {
      return await chrome.tabs.captureVisibleTab(windowId, { format: 'jpeg', quality: 80 })
    } catch (e) {
      // Quota, a restricted page, or a minimized window. Never fatal.
      return null
    }
  }
  captureChain = captureChain.then(run, run)
  return captureChain
}

// --- rolling frame ----------------------------------------------------------

/**
 * A viewport capture taken while idle. This is the free "before" image: at click time we
 * already have it, so a click costs one capture (the after) instead of two.
 */
const rolling = new Map() // tabId -> {dataUrl, at}
const ROLLING_MS = 1000

async function refreshRolling(tabId, windowId) {
  const cur = rolling.get(tabId)
  if (cur && Date.now() - cur.at < ROLLING_MS) return cur.dataUrl
  const dataUrl = await scheduleCapture(windowId)
  if (dataUrl) rolling.set(tabId, { dataUrl, at: Date.now() })
  return dataUrl || (cur && cur.dataUrl) || null
}

// --- live recording state ---------------------------------------------------

/**
 * NOT a global. This is the bug that broke the first real run: `live` was a module global,
 * MV3 kills the worker after 30 seconds idle and takes every global with it, so the first
 * pause in clicking silently ended the recording while the panel still said "recording".
 *
 * Now the pointer lives in chrome.storage.session (survives worker death, cleared on browser
 * restart, which is correct: a recording should not outlive the browser) and the session
 * itself lives in IndexedDB. Nothing is trusted from memory.
 *
 * `pending` is the one thing that can be in memory: it holds a partially built step between
 * pointerdown and settle, a window of at most 2.5 seconds. If the worker dies inside that
 * window the step is already persisted with its before-frame, it just never gets an
 * after-frame, which degrades one step instead of ending the session.
 */
const pending = new Map() // seq -> {step, dpr, redactRects, beforeUrl}

async function getLive() {
  const s = await chrome.storage.session.get(['live'])
  return s.live || null
}

async function setLive(value) {
  if (value) await chrome.storage.session.set({ live: value })
  else await chrome.storage.session.remove(['live'])
}

async function loadSession(id) {
  return id ? idb.getSession(id) : null
}

async function saveStep(sessionId, step) {
  const s = await idb.getSession(sessionId)
  if (!s) return null
  const i = s.steps.findIndex((x) => x.id === step.id)
  if (i >= 0) s.steps[i] = step
  else s.steps.push(step)
  await idb.putSession(s)          // write BEFORE ack, always
  return s
}

function notifyPanel(msg) {
  chrome.runtime.sendMessage(Object.assign({ to: 'oruga-panel' }, msg)).catch(() => {})
}

// --- origin allowlist -------------------------------------------------------

/**
 * A recording declares its origins up front. Wandering off them pauses loudly rather than
 * quietly hoovering up a different company's console.
 */
function originOf(url) {
  try { return new URL(url).origin } catch { return '' }
}

async function checkOrigin(session, url) {
  const origin = originOf(url)
  if (!origin) return { ok: false, reason: 'unparseable url' }
  if (!session.originAllowlist.length) {
    session.originAllowlist.push(origin)
    await idb.putSession(session)
    return { ok: true }
  }
  if (session.originAllowlist.includes(origin)) return { ok: true }
  return { ok: false, reason: 'off allowlist: ' + origin }
}

// --- step assembly ----------------------------------------------------------

async function beginStep(desc, tabId, windowId) {
  const live = await getLive()
  if (!live) return
  const session = await loadSession(live.sessionId)
  if (!session || session.paused) return

  const gate = await checkOrigin(session, desc.url)
  if (!gate.ok) {
    session.paused = true
    session.pauseReason = gate.reason
    await idb.putSession(session)
    notifyPanel({ kind: 'paused', reason: gate.reason })
    return
  }

  const beforeUrl = await refreshRolling(tabId, windowId)
  const step = makeStep({
    type: desc.type === 'change' ? STEP_TYPES.CHANGE
      : desc.type === 'key' ? STEP_TYPES.KEY : STEP_TYPES.CLICK,
    seq: desc.seq,
    pageTitle: desc.pageTitle,
    url: desc.url,
    section: desc.section,
    target: desc.target,
    selectors: desc.selectors,
    field: desc.field || null,
  })

  if (beforeUrl) {
    try {
      const stored = await shot.toStorageFrame(beforeUrl)
      const key = step.id + '-before'
      await idb.putFrame(key, stored.blob)
      step.beforeFrame = key
    } catch { /* a step without a frame is still a step */ }
  } else {
    step.signal = SIGNAL.REUSED
  }

  pending.set(desc.seq, {
    step,
    dpr: desc.dpr || 1,
    redactRects: desc.redactRects || [],
    beforeUrl,
  })

  // Persisted BEFORE the panel is told, always. If the worker dies right here the step is
  // already on disk.
  await saveStep(live.sessionId, step)
  notifyPanel({ kind: 'step', step })
}

async function finishStep(seq, tabId, windowId, freshRects) {
  const live = await getLive()
  if (!live) return
  const held = pending.get(seq)
  if (!held) return
  pending.delete(seq)

  const afterUrl = await scheduleCapture(windowId)
  const step = held.step

  if (afterUrl) {
    try {
      const stored = await shot.toStorageFrame(afterUrl)
      const key = step.id + '-after'
      await idb.putFrame(key, stored.blob)
      step.afterFrame = key
      rolling.set(tabId, { dataUrl: afterUrl, at: Date.now() })

      if (step.beforeFrame) {
        const beforeBlob = await idb.getFrame(step.beforeFrame)
        const d = await shot.frameDiff(beforeBlob, stored.blob)
        if (d < 0.012) step.signal = SIGNAL.LOW
      }
    } catch { /* keep the step */ }
  }

  // Model frame: cropped toward the target, redacted, guarded. Built now so a later
  // narration call never touches the page again.
  if (held.beforeUrl && step.target.bbox) {
    try {
      const model = await shot.toModelFrame(
        held.beforeUrl, step.target.bbox,
        (freshRects && freshRects.length ? freshRects : held.redactRects), held.dpr
      )
      const key = step.id + '-model'
      await idb.putFrame(key, model.blob)
      step.modelFrame = key
    } catch (e) {
      if (e && e.name === 'AspectGuardError') {
        step.note = (step.note ? step.note + ' ' : '') + '[frame skipped: ' + e.message + ']'
      }
    }
  }

  await saveStep(live.sessionId, step)
  notifyPanel({ kind: 'stepDone', step })
}

// --- navigation -------------------------------------------------------------

chrome.webNavigation.onCommitted.addListener(async (details) => {
  const live = await getLive()
  if (!live || details.tabId !== live.tabId || details.frameId !== 0) return
  const session = await loadSession(live.sessionId)
  if (!session || session.paused) return

  const gate = await checkOrigin(session, details.url)
  if (!gate.ok) {
    session.paused = true
    session.pauseReason = gate.reason
    await idb.putSession(session)
    notifyPanel({ kind: 'paused', reason: gate.reason })
    return
  }

  // Any step still waiting to settle belongs to the OLD page. Close it out now with the
  // url and title captured at pointerdown, never re-attributed to the destination.
  for (const seq of [...pending.keys()]) {
    await finishStep(seq, live.tabId, live.windowId, [])
  }

  rolling.delete(details.tabId)

  // The new document gets a fresh content script from the manifest, but it starts with
  // recording=false. Turn it back on or the recording ends at the first navigation.
  setRecording(live.tabId, true).catch(() => {})

  const step = makeStep({
    type: STEP_TYPES.NAVIGATE,
    url: details.url,
    pageTitle: '',
    target: { name: scrubUrl(details.url) },
  })
  await saveStep(live.sessionId, step)
  notifyPanel({ kind: 'step', step })
})

// --- message routing --------------------------------------------------------

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (!msg) return

  // From the content script
  if (msg.from === 'oruga-capture') {
    handleContent(msg, sender).then((r) => reply(r || { ok: true })).catch(() => reply({ ok: false }))
    return true // async, because the live pointer now comes from storage
  }

  // From the panel
  if (msg.to === 'oruga-sw') {
    handlePanel(msg).then((r) => reply(r || { ok: true })).catch((e) => reply({ ok: false, error: String(e && e.message || e) }))
    return true
  }
})

async function handleContent(msg, sender) {
  const tabId = sender.tab && sender.tab.id
  const windowId = sender.tab && sender.tab.windowId
  const live = await getLive()

  // A fresh document announcing itself. Answering with the recording flag removes the race
  // between a navigation committing and the new content script being ready, which is what
  // would otherwise end a recording at the first page change.
  if (msg.kind === 'hello') {
    const on = !!(live && tabId === live.tabId)
    return { ok: true, recording: on }
  }

  if (!live || tabId !== live.tabId) return { ok: true, recording: false }

  const s = msg.step || {}
  if (msg.kind === 'pointerdown') { beginStep(s, tabId, windowId); return { ok: true } }
  if (msg.kind === 'settled') { finishStep(msg.seq, tabId, windowId, msg.redactRects); return { ok: true } }
  if (msg.kind === 'change' || msg.kind === 'key') {
    beginStep(s, tabId, windowId).then(() => finishStep(s.seq, tabId, windowId, []))
    return { ok: true }
  }
  return { ok: true }
}

async function handlePanel(msg) {
  switch (msg.kind) {
    case 'start': {
      const tab = await activeTab()
      if (!tab) throw new Error('no active tab')
      if (isRestricted(tab.url)) {
        throw new Error('cannot record this page (' + shortHost(tab.url) + '). ' +
          'Chrome blocks extensions on chrome:// pages, the Web Store, other extensions, and the PDF viewer.')
      }
      const session = makeSession({
        goal: msg.goal, company: msg.company,
        originAllowlist: [originOf(tab.url)].filter(Boolean),
      })
      await idb.putSession(session)
      pending.clear()
      await setLive({ sessionId: session.id, tabId: tab.id, windowId: tab.windowId })
      await chrome.storage.local.set({ liveSessionId: session.id, liveTabId: tab.id, liveWindowId: tab.windowId })

      // A tab that was already open when the extension loaded has no content script, because
      // manifest declarations only apply at document load. Inject now so recording works
      // without asking the user to reload the page.
      await ensureInjected(tab.id)

      const reached = await setRecording(tab.id, true)
      await refreshRolling(tab.id, tab.windowId)
      return { ok: true, session, framesReached: reached }
    }
    case 'stop': {
      const live = await getLive()
      // Fall back to the storage.local pointer: if the browser restarted, storage.session is
      // gone but the recording is still on disk and must be closable.
      const ptr = live || (await chrome.storage.local.get(
        ['liveSessionId', 'liveTabId', 'liveWindowId']).then((s) => s.liveSessionId
          ? { sessionId: s.liveSessionId, tabId: s.liveTabId, windowId: s.liveWindowId } : null))
      if (!ptr) return { ok: true, session: null }

      for (const seq of [...pending.keys()]) {
        await finishStep(seq, ptr.tabId, ptr.windowId, [])
      }
      pending.clear()
      await setRecording(ptr.tabId, false).catch(() => {})
      const session = await loadSession(ptr.sessionId)
      if (session) {
        session.endedAt = new Date().toISOString()
        await idb.putSession(session)
      }
      await setLive(null)
      await chrome.storage.local.remove(['liveSessionId', 'liveTabId', 'liveWindowId'])
      return { ok: true, session }
    }
    case 'resume': {
      // After a worker death the panel re-attaches instead of losing the recording.
      const { liveSessionId, liveTabId, liveWindowId } = await chrome.storage.local.get(
        ['liveSessionId', 'liveTabId', 'liveWindowId'])
      if (!liveSessionId) return { ok: true, session: null }
      const session = await idb.getSession(liveSessionId)
      if (!session || session.endedAt) return { ok: true, session: null }
      await setLive({ sessionId: liveSessionId, tabId: liveTabId, windowId: liveWindowId })
      await ensureInjected(liveTabId).catch(() => {})
      await setRecording(liveTabId, true).catch(() => {})
      return { ok: true, session }
    }
    case 'getSession':
      return { ok: true, session: await idb.getSession(msg.sessionId) }
    case 'listSessions':
      return { ok: true, sessions: await idb.allSessions() }
    case 'unpause': {
      const live = await getLive()
      const session = await loadSession(live && live.sessionId)
      if (session) {
        session.paused = false
        session.pauseReason = ''
        if (msg.allowOrigin) session.originAllowlist.push(msg.allowOrigin)
        await idb.putSession(session)
      }
      return { ok: true, session }
    }
    case 'updateStep': {
      const session = await idb.getSession(msg.sessionId)
      if (!session) throw new Error('no such session')
      const i = session.steps.findIndex((s) => s.id === msg.step.id)
      if (i >= 0) session.steps[i] = Object.assign(session.steps[i], msg.step)
      await idb.putSession(session)
      return { ok: true }
    }
    case 'reorderSteps': {
      const session = await idb.getSession(msg.sessionId)
      if (!session) throw new Error('no such session')
      const byId = new Map(session.steps.map((s) => [s.id, s]))
      session.steps = msg.order.map((id) => byId.get(id)).filter(Boolean)
      await idb.putSession(session)
      return { ok: true }
    }
    case 'getFrame': {
      const blob = await idb.getFrame(msg.key)
      if (!blob) return { ok: false }
      // Blobs do not survive sendMessage. Hand over base64 and let the panel make the URL.
      return { ok: true, base64: await shot.blobToBase64(blob), type: blob.type }
    }
    case 'purge':
      await idb.purgeSession(msg.sessionId)
      return { ok: true }
    case 'storage':
      return { ok: true, estimate: await idb.estimateBytes(), frames: await idb.frameCount() }
    default:
      throw new Error('unknown message ' + msg.kind)
  }
}

/**
 * Inject capture.js into every frame of a tab that is already open.
 * Idempotent: capture.js guards against running twice, and executeScript on a frame that
 * already has it is harmless.
 */
async function ensureInjected(tabId) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      files: ['content/capture.js'],
    })
    return true
  } catch (e) {
    // Restricted page, or the frame is gone. The caller reports framesReached: 0.
    return false
  }
}

async function setRecording(tabId, value) {
  const frames = await chrome.webNavigation.getAllFrames({ tabId }).catch(() => null)
  const ids = frames ? frames.map((f) => f.frameId) : [0]
  let reached = 0
  for (const frameId of ids) {
    try {
      await chrome.tabs.sendMessage(tabId, { to: 'oruga-capture', kind: 'setRecording', value }, { frameId })
      reached++
    } catch { /* a frame with no content script, or a restricted one */ }
  }
  return reached
}

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true })
  return tab
}

function isRestricted(url) {
  if (!url) return true
  return /^(chrome|edge|about|devtools|view-source|chrome-extension|moz-extension):/i.test(url)
    || /^https:\/\/chromewebstore\.google\.com/i.test(url)
    || /^https:\/\/chrome\.google\.com\/webstore/i.test(url)
}

function shortHost(url) {
  try { return new URL(url).host || url.split(':')[0] + ':' } catch { return String(url).slice(0, 40) }
}

// --- lifecycle --------------------------------------------------------------

/**
 * Wire the toolbar button to the side panel.
 *
 * This runs at MODULE TOP LEVEL, on every worker start, not only in onInstalled.
 *
 * The bug this fixes: onInstalled does not fire when you reload an unpacked extension or
 * restart the browser. Setting the panel behavior only there meant it worked on the first
 * fresh install and then the toolbar button did nothing forever after, which looks exactly
 * like "the extension does not open any more".
 */
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true })
  .catch((e) => console.warn('oruga-scribe: setPanelBehavior failed:', e && e.message))

/**
 * Belt and braces. If openPanelOnActionClick is not honoured for any reason, open the panel
 * explicitly. The action click IS the user gesture sidePanel.open() requires, so this is a
 * legitimate call rather than a workaround.
 */
chrome.action.onClicked.addListener(async (tab) => {
  try {
    await chrome.sidePanel.setOptions({ path: 'panel/panel.html', enabled: true })
    await chrome.sidePanel.open(tab && tab.windowId != null
      ? { windowId: tab.windowId } : { tabId: tab.id })
  } catch (e) {
    console.warn('oruga-scribe: could not open the side panel:', e && e.message)
  }
})

/** MAIN world, document_start, so it beats page script to attachShadow. */
async function registerShadowPatch() {
  try {
    const existing = await chrome.scripting.getRegisteredContentScripts({ ids: ['oruga-shadow'] })
    if (existing.length) return
    await chrome.scripting.registerContentScripts([{
      id: 'oruga-shadow',
      matches: ['<all_urls>'],
      js: ['content/shadow-patch.js'],
      runAt: 'document_start',
      allFrames: true,
      world: 'MAIN',
    }])
  } catch (e) {
    // Not fatal: without it, closed shadow roots degrade to host-level capture.
    console.warn('oruga-scribe: could not register the MAIN world shadow patch:', e && e.message)
  }
}

chrome.runtime.onInstalled.addListener(registerShadowPatch)
chrome.runtime.onStartup.addListener(registerShadowPatch)
registerShadowPatch()   // and on every plain worker wake, since neither event is guaranteed
