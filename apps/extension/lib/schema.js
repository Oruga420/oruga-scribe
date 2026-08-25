/**
 * Step schema. Ported from @puppeteer/replay's shape (Apache-2.0), which solved the
 * selector-rot problem years ago: never store ONE selector, store an ordered fallback
 * bundle. Hashed React and Tailwind class names invalidate a single CSS path instantly.
 */

export const STEP_TYPES = Object.freeze({
  CLICK: 'click',
  CHANGE: 'change',
  NAVIGATE: 'navigate',
  MANUAL: 'manual',       // something the page could not report, user annotates it
  KEY: 'key',
})

export const SIGNAL = Object.freeze({
  NORMAL: 'normal',
  LOW: 'low_signal',      // nothing visibly changed, auto-prune candidate
  REUSED: 'frame_reused', // capture quota was exhausted, before-image is the rolling frame
})

let counter = 0

export function newStepId() {
  counter += 1
  return 's' + Date.now().toString(36) + '-' + counter.toString(36)
}

/**
 * @param {object} init
 * @returns a step record. Descriptors are the source of truth for the SOP, never selectors.
 */
export function makeStep(init) {
  return {
    id: init.id || newStepId(),
    type: init.type || STEP_TYPES.CLICK,
    at: init.at || new Date().toISOString(),
    seq: init.seq ?? 0,

    // where
    pageTitle: init.pageTitle || '',
    url: scrubUrl(init.url || ''),
    frameId: init.frameId ?? 0,
    section: init.section || '',          // nearest heading or landmark

    // what, human readable. This is what the SOP is written from.
    target: {
      role: init.target?.role || '',
      name: init.target?.name || '',      // computed accessible name
      tag: init.target?.tag || '',
      text: init.target?.text || '',
      testId: init.target?.testId || '',
      bbox: init.target?.bbox || null,
      inShadow: !!init.target?.inShadow,
      inIframe: !!init.target?.inIframe,
    },

    // machine readable fallbacks, ordered best to worst
    selectors: init.selectors || [],

    // fields: NEVER the typed value, only that something was entered
    field: init.field || null,            // {type, label, placeholder, filled: true}

    // frames
    beforeFrame: init.beforeFrame || null, // IndexedDB key
    afterFrame: init.afterFrame || null,

    signal: init.signal || SIGNAL.NORMAL,
    note: init.note || '',                 // user typed annotation
    narration: init.narration || '',       // filled in later, disposable
    pruned: false,
  }
}

/**
 * Drop the parts of a URL that carry credentials or session state.
 * Runs at capture time so a secret never even reaches storage.
 */
export function scrubUrl(raw) {
  if (!raw) return ''
  try {
    const u = new URL(raw)
    u.hash = ''
    u.username = ''
    u.password = ''
    // KEEP IDENTICAL to the kill list in relay/scrub.js. The harness asserts it (D6).
    // These two drifted once, silently: the relay redacted email and this one did not, so
    // an address in a query string survived capture time on the exact function the whole
    // premise rests on. Nothing caught it because nothing compared them.
    const kill = /token|key|secret|passw|sig|auth|session|code|state|jwt|email/i
    for (const k of [...u.searchParams.keys()]) {
      if (kill.test(k)) u.searchParams.set(k, 'REDACTED')
    }
    return u.toString()
  } catch {
    return '(unparseable url)'
  }
}

/** A short label for the step list, before any model has seen it. */
export function stepLabel(step) {
  const name = step.target.name || step.target.text || step.target.tag || 'element'
  switch (step.type) {
    case STEP_TYPES.NAVIGATE: return 'Go to ' + shortUrl(step.url)
    case STEP_TYPES.CHANGE: return 'Enter a value into ' + (step.field?.label || name)
    case STEP_TYPES.KEY: return 'Press ' + name
    case STEP_TYPES.MANUAL: return step.note || 'Manual step (needs a note)'
    default: return 'Click ' + name
  }
}

export function shortUrl(raw) {
  try {
    const u = new URL(raw)
    return u.host + (u.pathname === '/' ? '' : u.pathname)
  } catch {
    return raw
  }
}

export function makeSession(init) {
  return {
    id: init.id || 'rec' + Date.now().toString(36),
    goal: init.goal || '',
    company: init.company || 'personal',
    startedAt: new Date().toISOString(),
    endedAt: null,
    originAllowlist: init.originAllowlist || [],
    steps: [],
    paused: false,
    pauseReason: '',
  }
}
