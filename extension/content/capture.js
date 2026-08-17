/**
 * Content script. document_start, all_frames, ISOLATED world.
 *
 * Responsibilities, in order of importance:
 *   1. On pointerdown, synchronously serialize the target. By the time `click` fires the
 *      node is often already gone in a React app, so waiting is not an option.
 *   2. Run the settle race so the "after" screenshot lands when the page has stopped moving.
 *   3. Never let a password or a typed value leave the page.
 *
 * It reports to the service worker and does no capturing itself: chrome.tabs is not
 * reachable from here.
 */

const PORT_NAME = 'oruga-capture'
let recording = false
let seq = 0

// --- redaction, at the boundary ---------------------------------------------

const SECRET_AUTOCOMPLETE = new Set([
  'current-password', 'new-password', 'cc-number', 'cc-csc', 'cc-exp',
  'cc-exp-month', 'cc-exp-year', 'one-time-code',
])

function isSecretField(el) {
  if (!el || !el.tagName) return false
  const tag = el.tagName.toLowerCase()
  if (tag === 'input' && (el.type === 'password' || el.type === 'hidden')) return true
  const ac = (el.getAttribute && el.getAttribute('autocomplete') || '').toLowerCase()
  if (SECRET_AUTOCOMPLETE.has(ac)) return true
  if (el.closest && el.closest('[data-redact],[data-sensitive]')) return true
  return false
}

/** Rects the service worker must paint solid black before any frame leaves the machine. */
function redactionRects() {
  const rects = []
  const sel = 'input[type=password],[data-redact],[data-sensitive],' +
    '[autocomplete*="password"],[autocomplete*="cc-"],[autocomplete="one-time-code"]'
  let nodes = []
  try { nodes = document.querySelectorAll(sel) } catch { return rects }
  for (const n of nodes) {
    const r = n.getBoundingClientRect()
    if (r.width > 0 && r.height > 0 && r.bottom > 0 && r.top < innerHeight) {
      rects.push({ x: r.x, y: r.y, width: r.width, height: r.height })
    }
  }
  return rects
}

// --- accessible name --------------------------------------------------------

/**
 * accname 1.2, the practical subset. There is no built-in API for this in page JS:
 * getComputedAccessibleNode never shipped, and getComputedRole/getComputedLabel exist
 * only as WebDriver commands. The full tree is reachable through chrome.debugger, which
 * costs the yellow "started debugging" banner on every tab, so it is not worth it.
 */
function accName(el, depth = 0) {
  if (!el || depth > 3) return ''
  const attr = (n) => (el.getAttribute && el.getAttribute(n)) || ''

  const labelledBy = attr('aria-labelledby')
  if (labelledBy) {
    const parts = labelledBy.split(/\s+/)
      .map((id) => {
        const root = el.getRootNode ? el.getRootNode() : document
        const ref = (root.getElementById && root.getElementById(id)) || document.getElementById(id)
        return ref ? text(ref) : ''
      })
      .filter(Boolean)
    if (parts.length) return clean(parts.join(' '))
  }

  const aria = attr('aria-label')
  if (aria.trim()) return clean(aria)

  const tag = (el.tagName || '').toLowerCase()

  if (el.labels && el.labels.length) {
    const l = clean([...el.labels].map(text).join(' '))
    if (l) return l
  }

  if (tag === 'img' || tag === 'area') {
    const alt = attr('alt')
    if (alt.trim()) return clean(alt)
  }

  if (tag === 'input') {
    const type = (el.type || '').toLowerCase()
    if (type === 'submit' || type === 'button' || type === 'reset') {
      if (el.value) return clean(el.value)
    }
    const ph = attr('placeholder')
    if (ph.trim()) return clean(ph)
  }

  if (tag === 'button' || tag === 'a' || tag === 'summary' ||
      attr('role') === 'button' || attr('role') === 'link' || attr('role') === 'tab') {
    const t = text(el)
    if (t) return clean(t)
  }

  const title = attr('title')
  if (title.trim()) return clean(title)

  const t = text(el)
  if (t) return clean(t)

  // An icon-only control often has its name on the parent.
  if (el.parentElement) return accName(el.parentElement, depth + 1)
  return ''
}

function text(el) {
  if (!el) return ''
  // innerText respects visibility, textContent does not. Fall back for detached nodes.
  const s = (el.innerText != null && el.innerText !== '') ? el.innerText : (el.textContent || '')
  return s
}

function clean(s) {
  return String(s).replace(/\s+/g, ' ').trim().slice(0, 120)
}

function roleOf(el) {
  const explicit = el.getAttribute && el.getAttribute('role')
  if (explicit) return explicit.trim().toLowerCase()
  const tag = (el.tagName || '').toLowerCase()
  const map = {
    a: el.hasAttribute && el.hasAttribute('href') ? 'link' : 'generic',
    button: 'button', select: 'combobox', textarea: 'textbox',
    summary: 'button', h1: 'heading', h2: 'heading', h3: 'heading',
    h4: 'heading', h5: 'heading', h6: 'heading', nav: 'navigation',
    table: 'table', form: 'form', label: 'label',
  }
  if (tag === 'input') {
    const t = (el.type || 'text').toLowerCase()
    if (t === 'checkbox') return 'checkbox'
    if (t === 'radio') return 'radio'
    if (t === 'submit' || t === 'button' || t === 'reset') return 'button'
    if (t === 'range') return 'slider'
    return 'textbox'
  }
  return map[tag] || 'generic'
}

/** The nearest heading or landmark above the target. Cheap context that lifts narration a lot. */
function sectionOf(el) {
  let node = el
  while (node && node !== document.body) {
    let sib = node.previousElementSibling
    while (sib) {
      if (/^h[1-6]$/i.test(sib.tagName)) return clean(text(sib))
      const h = sib.querySelector && sib.querySelector('h1,h2,h3,h4,h5,h6')
      if (h) return clean(text(h))
      sib = sib.previousElementSibling
    }
    const lm = node.closest && node.closest('section[aria-label],[role=region][aria-label],dialog,[role=dialog]')
    if (lm && lm !== node) {
      const n = lm.getAttribute('aria-label')
      if (n) return clean(n)
    }
    node = node.parentElement
  }
  const h1 = document.querySelector('h1')
  return h1 ? clean(text(h1)) : ''
}

// --- selectors, ordered fallback bundle -------------------------------------

function selectorBundle(el) {
  const out = []
  const testId = el.getAttribute && (
    el.getAttribute('data-testid') || el.getAttribute('data-test-id') ||
    el.getAttribute('data-test') || el.getAttribute('data-cy')
  )
  if (testId) out.push({ kind: 'testid', value: '[data-testid="' + cssEscape(testId) + '"]' })
  if (el.id && !/^[0-9]/.test(el.id) && !looksGenerated(el.id)) {
    out.push({ kind: 'id', value: '#' + cssEscape(el.id) })
  }
  const role = roleOf(el)
  const name = accName(el)
  if (role !== 'generic' && name) out.push({ kind: 'role+name', value: role + '[name="' + name + '"]' })
  if (name) out.push({ kind: 'text', value: name })
  out.push({ kind: 'csspath', value: cssPath(el) })
  return out
}

/** Hashed class names and framework ids rot immediately. Do not lead with them. */
function looksGenerated(s) {
  return /^(?:[a-z]+[-_]?)?[0-9a-f]{6,}$/i.test(s) || /^(?:mui|radix|headless|ember|react)[-:]/i.test(s)
}

function cssEscape(s) {
  return (window.CSS && CSS.escape) ? CSS.escape(s) : String(s).replace(/["\\]/g, '\\$&')
}

function cssPath(el) {
  const parts = []
  let node = el
  let hops = 0
  while (node && node.nodeType === 1 && hops < 6) {
    let part = node.tagName.toLowerCase()
    if (node.parentElement) {
      const sameTag = [...node.parentElement.children].filter((c) => c.tagName === node.tagName)
      if (sameTag.length > 1) part += ':nth-of-type(' + (sameTag.indexOf(node) + 1) + ')'
    }
    parts.unshift(part)
    node = node.parentElement
    hops++
  }
  return parts.join(' > ')
}

// --- the settle race --------------------------------------------------------

/**
 * Resolves when the page has stopped changing, or when 2.5s have passed, whichever first.
 * Navigation is detected by the service worker (webNavigation), not here, because this
 * script dies with the document.
 */
function settle() {
  return new Promise((resolve) => {
    let done = false
    const finish = (why) => { if (!done) { done = true; cleanup(); resolve(why) } }

    let quietTimer = null
    const bump = () => {
      clearTimeout(quietTimer)
      quietTimer = setTimeout(() => finish('quiet'), 400)
    }

    let obs = null
    try {
      obs = new MutationObserver(bump)
      obs.observe(document.documentElement, {
        childList: true, subtree: true, attributes: true, characterData: false,
      })
    } catch { /* detached document */ }

    const ceiling = setTimeout(() => finish('ceiling'), 2500)
    bump()

    function cleanup() {
      clearTimeout(quietTimer)
      clearTimeout(ceiling)
      if (obs) obs.disconnect()
    }
  })
}

// --- messaging --------------------------------------------------------------

function send(msg) {
  try {
    chrome.runtime.sendMessage(Object.assign({ from: PORT_NAME }, msg))
  } catch {
    // Extension reloaded or context invalidated. Stop trying, the page keeps working.
    recording = false
  }
}

function describe(el, extra = {}) {
  const rect = el.getBoundingClientRect ? el.getBoundingClientRect() : null
  return Object.assign({
    pageTitle: document.title,
    url: location.href,
    section: sectionOf(el),
    target: {
      role: roleOf(el),
      name: accName(el),
      tag: (el.tagName || '').toLowerCase(),
      text: clean(text(el)).slice(0, 80),
      testId: (el.getAttribute && el.getAttribute('data-testid')) || '',
      bbox: rect ? { x: rect.x, y: rect.y, width: rect.width, height: rect.height } : null,
      inShadow: !!(el.getRootNode && el.getRootNode() instanceof ShadowRoot),
      inIframe: window !== window.top,
    },
    selectors: selectorBundle(el),
    dpr: window.devicePixelRatio || 1,
    redactRects: redactionRects(),
    viewport: { w: innerWidth, h: innerHeight },
  }, extra)
}

function realTarget(ev) {
  const path = ev.composedPath ? ev.composedPath() : null
  if (path && path.length) {
    for (const n of path) if (n && n.nodeType === 1) return n
  }
  return ev.target
}

// --- listeners --------------------------------------------------------------

// Capture phase and passive: we observe, we never interfere with the page.
const OPTS = { capture: true, passive: true }

let pending = null

addEventListener('pointerdown', (ev) => {
  if (!recording) return
  const el = realTarget(ev)
  if (!el || el.nodeType !== 1) return
  // Serialize NOW. In a React app this node may not exist by the time click fires.
  pending = describe(el, { seq: ++seq, type: 'click' })
  send({ kind: 'pointerdown', step: pending })
}, OPTS)

addEventListener('click', async (ev) => {
  if (!recording) return
  const snapshot = pending
  pending = null
  if (!snapshot) return
  const why = await settle()
  send({ kind: 'settled', seq: snapshot.seq, why, redactRects: redactionRects() })
}, OPTS)

addEventListener('change', (ev) => {
  if (!recording) return
  const el = realTarget(ev)
  if (!el || el.nodeType !== 1) return
  const secret = isSecretField(el)
  const d = describe(el, { seq: ++seq, type: 'change' })
  // NEVER the value. Only that a value was entered, and into what.
  d.field = {
    type: (el.type || el.tagName || '').toLowerCase(),
    label: accName(el),
    placeholder: secret ? '' : ((el.getAttribute && el.getAttribute('placeholder')) || ''),
    filled: !!(el.value && String(el.value).length),
    secret,
  }
  send({ kind: 'change', step: d })
}, OPTS)

addEventListener('keydown', (ev) => {
  if (!recording) return
  // Only keys that are actions in their own right. Never characters, never modifiers alone.
  if (!['Enter', 'Escape', 'Tab'].includes(ev.key)) return
  if (isSecretField(document.activeElement)) return
  const el = realTarget(ev) || document.body
  const d = describe(el, { seq: ++seq, type: 'key' })
  d.target.name = ev.key
  send({ kind: 'key', step: d })
}, OPTS)

// The service worker asks for fresh redaction rects right before it captures.
chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  if (!msg || msg.to !== PORT_NAME) return
  if (msg.kind === 'setRecording') {
    recording = !!msg.value
    seq = msg.seq || seq
    reply({ ok: true, recording })
    return
  }
  if (msg.kind === 'probe') {
    reply({
      ok: true,
      url: location.href,
      title: document.title,
      redactRects: redactionRects(),
      dpr: window.devicePixelRatio || 1,
      top: window === window.top,
    })
    return
  }
  return
})

// Announce presence so the panel can tell "no capture on this host" from "still loading".
send({ kind: 'hello', url: location.href, top: window === window.top })
