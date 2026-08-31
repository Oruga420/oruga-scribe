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
  goalEcho: $('goalEcho'), banner: $('banner'), reviewBanner: $('reviewBanner'),
  stop: $('stop'), note: $('note'),
  cSteps: $('cSteps'), cLow: $('cLow'), relayState: $('relayState'),
  steps: $('steps'), emptyMsg: $('emptyMsg'),
  reviewSteps: $('reviewSteps'), synth: $('synth'), back: $('back'),
  tpl: $('stepTpl'),
}

let session = null
let relayUp = false
let relayLoggedIn = false
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

  // An empty pane must say WHY it is empty. A blank rectangle reads as "the tool is broken"
  // and gives no clue whether nothing was clicked, nothing attached, or everything was pruned.
  if (!steps.length) {
    const p = document.createElement('p')
    p.className = 'empty'
    const total = session ? session.steps.length : 0
    p.textContent = total === 0
      ? (opts.review
        ? 'Nothing was recorded. If you were clicking, the recorder never attached to the page: '
          + 'reload the tab and start again.'
        : 'Go click something. Steps show up here as you work.')
      : 'All ' + total + ' steps were removed. Undo is not built yet, so start a new recording.'
    target.appendChild(p)
  }
  el.emptyMsg.classList.add('hidden')
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
  // Feedback FIRST, before any await. Start does real work (a capture, a content script
  // injection) and can take a second or two, and a button that looks inert reads as broken.
  el.start.disabled = true
  el.start.textContent = 'Starting...'

  // Do NOT await the relay probe here.
  //
  // An earlier version did, and it made Start feel dead: /health shells out to
  // `claude auth status`, and with the relay down the fetch sat until its 6s timeout, so
  // pressing Start did nothing visible for six seconds. Reported as "it will not let me start
  // a new one". The relay is irrelevant to recording, so use whatever the 5s poller last saw
  // and let a fresh probe update the banner when it lands.
  const relayWarning = () => (!relayUp
    ? 'The relay is not running, so there will be no narration and no SOP. Recording still works '
      + 'and nothing is lost: start the relay with start-relay.bat and press Write the SOP when '
      + 'you are done.'
    : (!relayLoggedIn
      ? 'The relay is running but not logged in, so narration and the SOP will fail. '
        + 'See relay/README-auth.md.'
      : ''))

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
      // Say WHICH failure it is. "Reload the tab" is actively misleading when the page never
      // loaded in the first place.
      const why = String(r.injectError || '')
      el.banner.className = 'banner bad'
      el.banner.textContent = /error page/i.test(why)
        ? 'That tab is showing an error page, not a real page, so there is nothing to record. '
          + 'Load the site first, then start again.'
        : /cannot be scripted|Cannot access|Missing host permission/i.test(why)
          ? 'Chrome does not allow extensions on this page, so it cannot be recorded. '
            + 'Try the tool on a normal http or https page.'
          : 'No capture on this page. Reload the tab so the recorder can attach, then start again.'
        + (why ? ' (' + why.slice(0, 90) + ')' : '')
      el.banner.classList.remove('hidden')
    } else {
      // Show the relay warning from the cached state right away, then refresh it in the
      // background so a relay that came up seconds ago clears the warning on its own.
      const now = relayWarning()
      if (now) {
        el.banner.className = 'banner warn'
        el.banner.textContent = now
        el.banner.classList.remove('hidden')
      }
      pingRelay().then(() => {
        const after = relayWarning()
        if (!after) el.banner.classList.add('hidden')
        else { el.banner.className = 'banner warn'; el.banner.textContent = after; el.banner.classList.remove('hidden') }
      }).catch(() => {})
    }
  } catch (e) {
    el.setupErr.textContent = String(e.message || e)
  } finally {
    el.start.disabled = false
    el.start.textContent = 'Start recording'
  }
})

el.stop.addEventListener('click', async () => {
  const r = await sw('stop').catch((e) => ({ ok: false, error: String(e) }))
  if (r && r.session) {
    session = r.session
  } else if (session) {
    // The worker may have restarted and lost its pointer. Read the session straight from disk
    // rather than showing an empty review over a recording that exists.
    const g = await sw('getSession', { sessionId: session.id }).catch(() => null)
    if (g && g.session) session = g.session
  }
  setState('review', '')
  show(el.review)
  renderList(el.reviewSteps, visibleSteps(), { review: true })
  el.reviewBanner.classList.add('hidden')
  if (r && r.ok === false && r.error) {
    el.reviewBanner.className = 'banner bad'
    el.reviewBanner.textContent = 'Stop reported: ' + r.error
    el.reviewBanner.classList.remove('hidden')
  }
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
  const inReview = el.rec.classList.contains('hidden')
  renderList(inReview ? el.reviewSteps : el.steps, visibleSteps(), { review: inReview })
  renderCounts()
}

el.synth.addEventListener('click', async () => {
  // Here the await IS correct: we are about to make a long call and need an accurate answer.
  // But say so on the button first, because the probe alone can take over a second.
  el.synth.disabled = true
  el.synth.textContent = 'Checking the relay...'
  await pingRelay()
  el.synth.disabled = false
  el.synth.textContent = 'Write the SOP'
  if (!relayUp || !relayLoggedIn) {
    el.reviewBanner.className = 'banner bad'
    el.reviewBanner.textContent = !relayUp
      ? 'The relay is not running. Start it with start-relay.bat (double click it, leave the '
        + 'window open), then press this button again. Your recording is safe on disk.'
      : 'The relay is running but not logged in, so it cannot write. See relay/README-auth.md, '
        + 'then press this button again. Your recording is safe on disk.'
    el.reviewBanner.classList.remove('hidden')
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
    // The bundle is a second artifact and must never be able to cost the SOP, so it runs after
    // the state is already 'done' and reports its own failure without throwing.
    await exportBundle(out.dir)
  } catch (e) {
    el.synth.disabled = false
    el.synth.textContent = 'Write the SOP'
    el.reviewBanner.className = 'banner bad'
    el.reviewBanner.textContent = String(e.message || e)
    el.reviewBanner.classList.remove('hidden')
  }
})

/**
 * Ship the screenshots to the relay so it can write the /sop-to-video bundle next to the SOP.
 *
 * ONLY `step.modelFrame` is ever read here. `beforeFrame` and `afterFrame` are full viewport
 * captures with nothing painted over them: the redaction pass runs on the model frame alone, so
 * those two must never leave the browser. loadThumb() falls back to beforeFrame for a thumbnail
 * that stays local; this function deliberately does not.
 */
async function exportBundle(dir) {
  if (!dir) return
  const steps = visibleSteps()
  const frames = []
  let noFrame = 0
  for (const step of steps) {
    if (!step.modelFrame) { noFrame++; continue }
    const r = await sw('getFrame', { key: step.modelFrame }).catch(() => null)
    if (!r || !r.ok || !r.base64) { noFrame++; continue }
    frames.push({ n: step.n, base64: r.base64 })
  }

  try {
    const res = await fetch(RELAY + '/bundle', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ dir, session: { ...session, steps }, frames }),
    })
    const out = await res.json()
    if (!out.ok) throw new Error(out.error || 'bundle failed')
    // Say what is missing rather than reporting a clean export. A bundle whose screenshots are
    // absent still produces a video, just an empty one, and that is worth knowing here.
    const gaps = []
    if (out.missingFrames && out.missingFrames.length) {
      gaps.push(out.missingFrames.length + ' without a screenshot')
    }
    if (noFrame) gaps.push(noFrame + ' with no redacted frame stored')
    el.reviewBanner.className = gaps.length ? 'banner warn' : 'banner ok'
    el.reviewBanner.textContent = 'SOP and video bundle written to ' + dir
      + ' (' + out.steps + ' steps'
      + (gaps.length ? ', ' + gaps.join(', ') : '') + ').'
    el.reviewBanner.classList.remove('hidden')
  } catch (e) {
    // The SOP is already on disk. Say the bundle failed, and do not undo the success above.
    el.reviewBanner.className = 'banner warn'
    el.reviewBanner.textContent = 'The SOP was written. The video bundle failed: '
      + String(e.message || e)
    el.reviewBanner.classList.remove('hidden')
  }
}

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
    // 1200ms was too tight: /health shells out to `claude auth status` on a cold cache, which
    // takes about 1.1s on its own, so the very first probe of a session timed out and the panel
    // showed "narration off" against a perfectly healthy relay.
    const r = await fetch(RELAY + '/health', { signal: AbortSignal.timeout(6000) })
    const j = await r.json()
    relayUp = !!j.ok
    relayLoggedIn = !!j.loggedIn
    el.relayState.className = 'relay ' + (j.loggedIn ? 'on' : 'off')
    el.relayState.textContent = j.loggedIn ? 'narration on' : 'relay up, not logged in'
    el.relayState.title = 'config dir: ' + (j.configDir || '?')
  } catch {
    relayUp = false
    relayLoggedIn = false
    el.relayState.className = 'relay off'
    el.relayState.textContent = 'narration off'
    el.relayState.title = 'the relay is not answering on ' + RELAY
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
    return
  }

  // Nothing live. Offer the most recent FINISHED recording so its SOP can still be written.
  //
  // THE BUG THIS FIXES: resume returns null once endedAt is set, so after pressing Stop, closing
  // and reopening the panel lost all access to the recording even though every step and frame was
  // still sitting in IndexedDB. The only apparent option was to record the whole thing again.
  const listed = await sw('listSessions').catch(() => null)
  const finished = ((listed && listed.sessions) || [])
    .filter((s) => s.endedAt && (s.steps || []).some((st) => !st.pruned))
    .sort((a, b) => String(b.endedAt).localeCompare(String(a.endedAt)))

  if (finished.length) {
    session = finished[0]
    el.goalEcho.textContent = session.goal
    show(el.review)
    setState('review', '')
    renderList(el.reviewSteps, visibleSteps(), { review: true })
    el.reviewBanner.className = 'banner warn'
    el.reviewBanner.textContent = 'This is your last finished recording (' +
      visibleSteps().length + ' steps, ' + String(session.endedAt).slice(0, 16).replace('T', ' ') +
      '). Write its SOP, or press "Start a new recording" to begin a different one.'
    el.reviewBanner.classList.remove('hidden')
    return
  }

  show(el.setup)
  setState('idle', '')
})()
