'use strict'

/**
 * relay/scrub.js - the redaction gate. Every outbound payload passes through here.
 *
 * FAIL CLOSED: if anything in this file throws, the caller drops the step rather than
 * sending it. A crash here must never degrade into "send it raw".
 *
 * This is the second of three layers. The first is the content script, which never even
 * reads a password field. The third is the human prune in the panel.
 */

const SECRET_PATTERNS = [
  [/\b[\w.+-]+@[\w-]+\.[\w.-]{2,}\b/g, '[email]'],
  [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.?[A-Za-z0-9_-]*/g, '[jwt]'],
  [/\bBearer\s+[\w.\-~+/]+=*/gi, 'Bearer [token]'],
  [/\bsk-[A-Za-z0-9_-]{16,}/g, '[api-key]'],
  [/\bpk-[A-Za-z0-9_-]{16,}/g, '[api-key]'],
  [/\bghp_[A-Za-z0-9]{20,}/g, '[github-token]'],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}/g, '[github-token]'],
  [/\bxox[baprs]-[A-Za-z0-9-]{10,}/g, '[slack-token]'],
  [/\bAKIA[0-9A-Z]{16}\b/g, '[aws-key]'],
  [/\bAIza[0-9A-Za-z_-]{35}\b/g, '[google-key]'],
  [/\b\d{3}-\d{2}-\d{4}\b/g, '[ssn]'],
  [/\+\d{1,3}[\s.-]?\(?\d{2,4}\)?[\s.-]?\d{3,4}[\s.-]?\d{3,4}\b/g, '[phone]'],
  // Long opaque runs: hex, base64ish. Last because it is the bluntest.
  [/\b[0-9a-f]{32,}\b/gi, '[hex]'],
  [/\b[A-Za-z0-9+/]{40,}={0,2}\b/g, '[opaque]'],
]

/** Card numbers, but only when they pass Luhn, so order numbers survive. */
function redactCards(s) {
  return s.replace(/\b(?:\d[ -]?){13,19}\b/g, (m) => {
    const digits = m.replace(/\D/g, '')
    if (digits.length < 13 || digits.length > 19) return m
    return luhn(digits) ? '[card]' : m
  })
}

function luhn(d) {
  let sum = 0
  let alt = false
  for (let i = d.length - 1; i >= 0; i--) {
    let n = d.charCodeAt(i) - 48
    if (alt) { n *= 2; if (n > 9) n -= 9 }
    sum += n
    alt = !alt
  }
  return sum % 10 === 0
}

let userBlocklist = []

/** Literal strings and regex sources the user never wants leaving the machine. */
function setBlocklist(list) {
  userBlocklist = (list || []).map((entry) => {
    if (typeof entry === 'string') return { re: new RegExp(escapeRe(entry), 'gi'), to: '[REDACTED]' }
    return { re: new RegExp(entry.pattern, entry.flags || 'gi'), to: entry.to || '[REDACTED]' }
  })
}

function escapeRe(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&') }

/** Scrub one string. Applied to every outbound label, name, url, note, heading. */
function scrubText(input) {
  if (input == null) return ''
  let s = String(input)
  if (s.length > 2000) s = s.slice(0, 2000) + '...'
  s = redactCards(s)
  for (const [re, to] of SECRET_PATTERNS) s = s.replace(re, to)
  for (const { re, to } of userBlocklist) s = s.replace(re, to)   // user list applies LAST
  return s
}

function scrubUrl(raw) {
  if (!raw) return ''
  try {
    const u = new URL(raw)
    u.hash = ''
    u.username = ''
    u.password = ''
    // KEEP IDENTICAL to the kill list in apps/extension/lib/schema.js. The harness
    // asserts it (D6). See the note there for what happened when they drifted.
    const kill = /token|key|secret|passw|sig|auth|session|code|state|jwt|email/i
    for (const k of [...u.searchParams.keys()]) {
      if (kill.test(k)) u.searchParams.set(k, 'REDACTED')
    }
    return scrubText(u.toString())
  } catch {
    return '(unparseable url)'
  }
}

/**
 * Build the payload that actually leaves the machine. Anything not explicitly copied here
 * does not go: an allowlist, not a denylist, so a new field added upstream cannot leak by
 * default.
 */
function scrubPayload(input) {
  if (!input || !Array.isArray(input.steps)) throw new Error('steps required')

  const steps = input.steps.map((s, i) => {
    const out = {
      n: i + 1,
      type: s.type || 'click',
      page: scrubText(s.pageTitle || ''),
      url: scrubUrl(s.url || ''),
      section: scrubText(s.section || ''),
      role: scrubText((s.target && s.target.role) || ''),
      name: scrubText((s.target && s.target.name) || ''),
      note: scrubText(s.note || ''),
    }
    if (s.field) {
      // The value itself is never present in the step to begin with. This is belt and braces.
      out.field = {
        kind: scrubText(s.field.type || ''),
        label: scrubText(s.field.label || ''),
        filled: !!s.field.filled,
        secret: !!s.field.secret,
      }
      if (out.field.secret) { out.field.label = '[secret field]'; out.name = '[secret field]' }
    }
    if (s.signal && s.signal !== 'normal') out.signal = s.signal
    return out
  })

  return {
    goal: scrubText(input.goal || ''),
    company: scrubText(input.company || 'personal'),
    steps,
  }
}

function renderNarrationPrompt(clean) {
  const lines = [
    'GOAL: ' + clean.goal,
    '',
    'STEPS TO NARRATE:',
  ]
  for (const s of clean.steps) {
    const parts = ['[' + s.n + '] ' + s.type]
    if (s.role) parts.push('role=' + s.role)
    if (s.name) parts.push('name="' + s.name + '"')
    if (s.field) parts.push('field="' + s.field.label + '" filled=' + s.field.filled)
    if (s.section) parts.push('section="' + s.section + '"')
    if (s.page) parts.push('page="' + s.page + '"')
    if (s.url) parts.push('url=' + s.url)
    if (s.note) parts.push('user note="' + s.note + '"')
    lines.push(parts.join('  '))
  }
  return lines.join('\n')
}

function renderSopPrompt(clean) {
  const lines = [
    'GOAL AS STATED BY THE OPERATOR: ' + clean.goal,
    '',
    'RECORDED STEP LOG. This is the only evidence you have. Do not add to it.',
    '',
  ]
  for (const s of clean.steps) {
    const parts = [String(s.n) + '. ' + s.type]
    if (s.role) parts.push('role=' + s.role)
    if (s.name) parts.push('name="' + s.name + '"')
    if (s.field) parts.push('field="' + s.field.label + '" filled=' + s.field.filled)
    if (s.section) parts.push('section="' + s.section + '"')
    if (s.page) parts.push('page="' + s.page + '"')
    if (s.url) parts.push('url=' + s.url)
    if (s.note) parts.push('OPERATOR NOTE: "' + s.note + '"')
    if (s.signal) parts.push('(' + s.signal + ')')
    parts.push('screenshot=step-' + String(s.n).padStart(2, '0') + '.webp')
    lines.push(parts.join('  '))
  }
  return lines.join('\n')
}

module.exports = {
  scrubText,
  scrubUrl,
  scrubPayload,
  renderNarrationPrompt,
  renderSopPrompt,
  setBlocklist,
  luhn,
}
