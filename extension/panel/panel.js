/**
 * Side panel. This owns the session.
 *
 * Not the service worker: it dies after 30s idle and an open panel does not keep it alive.
 * The panel document lives as long as it is open, so the state machine belongs here and
 * the worker stays a thin router over IndexedDB.
 */

import { stepLabel, shortUrl, SIGNAL } from '../lib/schema.js'

const RELAY = 'http://127.0.0.1:8787'

const $ = (id) => document.getElementById(id)
const el = {
  dot: $('dot'), state: $('state'),
  setup: $('setup'), rec: $('rec'), review: $('review'),
  goal: $('goal'), company: $('company'), start: $('start'), setupErr: $('setupErr'),
  goalEcho: $('goalEcho'), banner: $('banner'), stop: $('stop'), note: $('note'),
  cSteps: $('cSteps'), cLow: $('cLow'), relayState: $('relayState'),
  steps: $('steps'), emptyMsg: $('emptyMsg'),
  reviewSteps: $('reviewSteps'), synth: $('synth'), back: $('back'),
  tpl: $('stepTpl'),
}

let session = null
let relayUp = false
const thumbCache = new Map()

// --- worker bridge ----------------------------------------------------------

function sw(kind, extra = {}) {
  return chrome.runtime.sendMessage(Object.assign({ to: 'oruga-sw', kind }, extra))
}

// --- rendering --------------------------------------------------------------

function show(pane) {
  for (const p of [el.setup, el.rec, el.review]) p.classList.add('hidden')
  pane.classList.remove('hidden')
}

function setState(text, cls) {
  el.state.textContent = text
  el.dot.className = 'dot' + (cls ? ' ' + cls : '')
}

function visibleSteps() {
  return (session ? session.steps : []).filter((s) => !s.pruned)
}

function renderList(target, steps, opts = {}) {
  target.textContent = ''
  steps.forEach((step, i) => {
    const node = el.tpl.content.cloneNode(true)
    const li = node.querySelector('.step')
    li.dataset.id = step.id
    if (step.signal === SIGNAL.LOW) li.classList.add('low')

    node.querySelector('.num').textContent = String(i + 1)
    node.querySelector('.label').textContent = stepLabel(step)

    const bits = []
    if (step.section) bits.push(step.section)
    if (step.url) bits.push(shortUrl(step.url))
    if (step.signal === SIGNAL.LOW) bits.push('nothing changed')
    if (step.signal === SIGNAL.REUSED) bits.push('frame reused')
    if (step.field && step.field.secret) bits.push('secret field, not captured')
    node.querySelector('.meta').textContent = bits.join('  /  ')

    if (step.narration) node.querySelector('.narr').textContent = step.narration
    if (step.note) {
      const n = node.querySelector('.noteline')
      n.textContent = step.note
      n.classList.remove('hidden')
    }

    node.querySelector('.x').addEventListener('click', () => prune(step.id))

    const img = node.querySelector('.thumb')
    if (opts.thumbs !== false && (step.modelFrame || step.beforeFrame)) {
      loadThumb(step.modelFrame || step.beforeFrame, img)
    }

    target.appendChild(node)
  })
  el.emptyMsg.classList.toggle('hidden', steps.length > 0)
}

async function loadThumb(key, img) {
  if (!key) return
  if (thumbCache.has(key)) {
    img.src = thumbCache.get(key)
    img.classList.remove('hidden')
    return
  }
  const r = await sw('getFrame', { key }).catch(() => null)
  if (!r || !r.ok) return
  // Blobs do not survive sendMessage, so the worker hands over base64 and the URL is
  // minted here. URL.createObjectURL does not exist in a service worker anyway.
  const url = 'data:' + (r.type || 'image/webp') + ';base64,' + r.base64
  thumbCache.set(key, url)
  img.src = url
  img.classList.remove('hidden')
}

function renderCounts() {
  const steps = visibleSteps()
  el.cSteps.textContent = String(steps.length)
  el.cLow.textContent = String(steps.filter((s) => s.signal === SIGNAL.LOW).length)
}

function renderBanner() {
  if (!session || !session.paused) {
    el.banner.classList.add('hidden')
    return
  }
  el.banner.className = 'banner warn'
  el.banner.textContent = 'Recording paused: ' + session.pauseReason + '. '
  const btn = document.createElement('button')
  btn.textContent = 'Allow this site and continue'
  btn.addEventListener('click', async () => {
    const origin = (session.pauseReason.match(/off allowlist:\s*(\S+)/) || [])[1]
    const r = await sw('unpause', { allowOrigin: origin })
    if (r && r.session) session = r.session
    setState('recording', 'live')
    renderBanner()
  })
  el.banner.appendChild(btn)
  el.banner.classList.remove('hidden')
  setState('paused', 'paused')
}

// --- actions ----------------------------------------------------------------

el.start.addEventListener('click', async () => {
  el.setupErr.textContent = ''
  const goal = el.goal.value.trim()
  if (goal.length < 8) {
    el.setupErr.textContent = 'Write the goal first. It is not paperwork: without it the ' +
      'narration has no idea what you are trying to accomplish.'
    el.goal.focus()
    return
  }
  el.start.disabled = true
  try {
    const r = await sw('start', { goal, company: el.company.value })
    if (!r || !r.ok) throw new Error((r && r.error) || 'could not start')
    session = r.session
    el.goalEcho.textContent = session.goal
    show(el.rec)
    setState('recording', 'live')
    renderList(el.steps, [])
    renderCounts()
    if (!r.framesReached) {
      el.banner.className = 'banner bad'
      el.banner.textContent = 'No capture on this page. Reload the tab so the recorder can attach, ' +
        'then start again.'
      el.banner.classList.remove('hidden')
    }
  } catch (e) {
    el.setupErr.textContent = String(e.message || e)
  } finally {
    el.start.disabled = false
  }
})

el.stop.addEventListener('click', async () => {
  const r = await sw('stop')
  if (r && r.session) session = r.session
  setState('review', '')
  show(el.review)
  renderList(el.reviewSteps, visibleSteps())
})

el.back.addEventListener('click', async () => {
  const r = await sw('resume')
  if (r && r.session) {
    session = r.session
    show(el.rec)
    setState('recording', 'live')
  } else {
    show(el.setup)
    setState('idle', '')
  }
})

el.note.addEventListener('click', async () => {
  const steps = visibleSteps()
  const last = steps[steps.length - 1]
  if (!last) return
  const text = prompt('Note for step ' + steps.length + ' (' + stepLabel(last) + ')')
  if (!text) return
  last.note = text
  await sw('updateStep', { sessionId: session.id, step: { id: last.id, note: text } })
  renderList(el.steps, visibleSteps())
})

async function prune(id) {
  const step = session.steps.find((s) => s.id === id)
  if (!step) return
  step.pruned = true
  await sw('updateStep', { sessionId: session.id, step: { id, pruned: true } })
  renderList(el.rec.classList.contains('hidden') ? el.reviewSteps : el.steps, visibleSteps())
  renderCounts()
}

el.synth.addEventListener('click', async () => {
  if (!relayUp) {
    el.banner.className = 'banner bad'
    el.banner.textContent = 'The relay is not running, so nothing can be written yet. ' +
      'Start it with: node relay/server.js'
    el.banner.classList.remove('hidden')
    el.review.prepend(el.banner)
    return
  }
  el.synth.disabled = true
  el.synth.textContent = 'Writing...'
  try {
    const res = await fetch(RELAY + '/synthesize', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ session: { ...session, steps: visibleSteps() } }),
    })
    const out = await res.json()
    if (!out.ok) throw new Error(out.error || 'synthesis failed')
    setState('done', '')
    el.synth.textContent = 'SOP written'
  } catch (e) {
    el.synth.disabled = false
    el.synth.textContent = 'Write the SOP'
    el.banner.className = 'banner bad'
    el.banner.textContent = String(e.message || e)
    el.banner.classList.remove('hidden')
    el.review.prepend(el.banner)
  }
})

// --- live updates from the worker -------------------------------------------

chrome.runtime.onMessage.addListener((msg) => {
  if (!msg || msg.to !== 'oruga-panel' || !session) return
  if (msg.kind === 'step' || msg.kind === 'stepDone') {
    const i = session.steps.findIndex((s) => s.id === msg.step.id)
    if (i >= 0) session.steps[i] = Object.assign(session.steps[i], msg.step)
    else session.steps.push(msg.step)
    renderList(el.steps, visibleSteps())
    renderCounts()
    el.steps.lastElementChild?.scrollIntoView({ block: 'nearest' })
  }
  if (msg.kind === 'paused') {
    session.paused = true
    session.pauseReason = msg.reason
    renderBanner()
  }
})

// --- relay health -----------------------------------------------------------

/**
 * Narration is optional by design. The recorder works with the relay down, it just does
 * not write anything. That is deliberate: losing narration should never lose a recording.
 */
async function pingRelay() {
  try {
    const r = await fetch(RELAY + '/health', { signal: AbortSignal.timeout(1200) })
    const j = await r.json()
    relayUp = !!j.ok
    el.relayState.className = 'relay ' + (j.loggedIn ? 'on' : 'off')
    el.relayState.textContent = j.loggedIn ? 'narration on' : 'relay up, not logged in'
  } catch {
    relayUp = false
    el.relayState.className = 'relay off'
    el.relayState.textContent = 'narration off'
  }
}

// --- boot -------------------------------------------------------------------

;(async () => {
  pingRelay()
  setInterval(pingRelay, 5000)

  // Re-attach to a recording that survived a worker death or a panel close.
  const r = await sw('resume').catch(() => null)
  if (r && r.session) {
    session = r.session
    el.goalEcho.textContent = session.goal
    show(el.rec)
    setState(session.paused ? 'paused' : 'recording', session.paused ? 'paused' : 'live')
    renderList(el.steps, visibleSteps())
    renderCounts()
    renderBanner()
  } else {
    show(el.setup)
    setState('idle', '')
  }
})()
