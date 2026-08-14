'use strict'

/**
 * relay/smoke.js - the 60 second golden path test.
 *
 * Run it after any Claude Code auto update. If it fails, wiki/measured-baselines.md is
 * stale and the spawn config needs re-verifying before trusting the relay.
 *
 *   node relay/smoke.js
 *
 * Offline checks always run. Live checks run only once the isolated config dir has a
 * personal login (see relay/README-auth.md).
 */

const fs = require('node:fs')
const path = require('node:path')
const { execFileSync } = require('node:child_process')
const C = require('./claude')

let pass = 0
let fail = 0
const skipped = []

function ok(name, detail) {
  pass++
  console.log('  PASS  ' + name + (detail ? '   ' + detail : ''))
}
function bad(name, detail) {
  fail++
  console.log('  FAIL  ' + name + (detail ? '\n        ' + detail : ''))
}
function skip(name, why) {
  skipped.push(name)
  console.log('  SKIP  ' + name + '   ' + why)
}
function check(name, fn) {
  try {
    const detail = fn()
    ok(name, typeof detail === 'string' ? detail : '')
  } catch (e) {
    bad(name, e.message)
  }
}

console.log('\noruga-scribe relay smoke test\n' + '='.repeat(60) + '\n')
console.log('OFFLINE CHECKS')

check('native claude.exe resolves', () => {
  const exe = C.resolveExe()
  if (!exe.toLowerCase().endsWith('.exe') && process.platform === 'win32') {
    throw new Error('resolved to a non-exe on win32: ' + exe + '\n' +
      'Routing through .cmd corrupts arguments. Set CLAUDE_BIN to claude.exe.')
  }
  return path.basename(exe)
})

check('claude version is recorded', () => {
  const v = execFileSync(C.resolveExe(), ['--version'], { encoding: 'utf8' }).trim()
  const baseline = '2.1.219'
  if (!v.includes(baseline)) {
    throw new Error('claude is ' + v + ' but wiki/measured-baselines.md was measured on ' +
      baseline + '.\nRe-run the latency measurements before trusting the spawn config.')
  }
  return v
})

check('both prompt files exist', () => {
  for (const f of ['narrate-system.txt', 'sop-system.txt']) {
    const p = path.join(__dirname, 'prompts', f)
    if (!fs.existsSync(p)) throw new Error('missing ' + p)
    if (fs.readFileSync(p, 'utf8').trim().length < 100) throw new Error('suspiciously short: ' + f)
  }
  return '2 files'
})

check('no em dashes or en dashes in prompts', () => {
  for (const f of ['narrate-system.txt', 'sop-system.txt']) {
    const body = fs.readFileSync(path.join(__dirname, 'prompts', f), 'utf8')
    if (/[—–]/.test(body)) throw new Error(f + ' contains an em dash or en dash')
  }
  return 'clean'
})

check('user message builds valid JSONL with an image block', () => {
  const line = C.buildUserMessage('narrate this', { base64: 'AAAA', mediaType: 'image/webp' })
  if (line.includes('\n')) throw new Error('payload contains a newline, which would split the JSONL line')
  const parsed = JSON.parse(line)
  const kinds = parsed.message.content.map((b) => b.type)
  if (kinds[0] !== 'image') throw new Error('image block must come first, got ' + kinds.join(','))
  if (!line.includes(C.NO_IMAGE_SENTINEL)) throw new Error('sentinel instruction missing')
  return kinds.join(' + ')
})

check('dropped image is detected both ways', () => {
  if (!C.detectImageFailure('API Error: an image in the conversation could not be processed and was removed.')) {
    throw new Error('missed the CLI phrase')
  }
  if (!C.detectImageFailure(C.NO_IMAGE_SENTINEL)) throw new Error('missed the sentinel')
  if (C.detectImageFailure('Click Save on the invoice page.')) throw new Error('false positive on normal text')
  return 'phrase + sentinel'
})

check('config dir points at the isolated home, not the machine default', () => {
  const dir = C.configDir()
  const machineDefault = path.join(process.env.USERPROFILE || process.env.HOME || '', '.claude')
  if (path.resolve(dir) === path.resolve(machineDefault)) {
    throw new Error('config dir is the machine default, which is the Promise seat. ' +
      'This project must never spend company quota.')
  }
  return path.relative(path.join(__dirname, '..'), dir)
})

// ---------------------------------------------------------------------------

console.log('\nLIVE CHECKS')

const loggedIn = fs.existsSync(path.join(C.configDir(), '.claude.json'))

async function live() {
  if (!loggedIn) {
    skip('narration call', 'isolated config dir has no login yet')
    skip('thinking is disabled', 'needs a live call')
    return
  }

  const payload = C.buildUserMessage(
    'GOAL: rotate the Slack bot token.\n' +
    'PAGE: "App Credentials" at api.slack.com/apps/A123/oauth\n' +
    'STEP: clicked role=button name="Regenerate"\n' +
    'Narrate this step.'
  )

  let firstChunkAt = null
  const t0 = Date.now()
  let res
  try {
    res = await C.run('narrate', payload, {
      onDelta: () => { if (firstChunkAt === null) firstChunkAt = Date.now() - t0 },
    })
  } catch (e) {
    bad('narration call', e.message)
    return
  }

  ok('narration call', JSON.stringify(res.text.slice(0, 70)))

  const model = res.model.join(',')
  if (model.includes('haiku')) ok('ran on haiku, not the settings.json default', model)
  else bad('ran on haiku', 'model was ' + model + '. --model was ignored or overridden.')

  const out = res.usage ? res.usage.output_tokens : null
  if (out === null) bad('usage present', 'no usage in the result event')
  else if (out > 200) {
    bad('thinking is disabled',
      out + ' output tokens. Expected well under 200. MAX_THINKING_TOKENS=0 is not taking effect, ' +
      'which costs roughly 7 seconds per call.')
  } else ok('thinking is disabled', out + ' output tokens')

  const inTok = res.usage ? res.usage.input_tokens + (res.usage.cache_read_input_tokens || 0) : 0
  if (inTok > 2000) {
    bad('system prompt is replaced',
      inTok + ' input tokens. Expected a few hundred. --system-prompt-file is not taking effect, ' +
      'so the CLI is answering as its own agent persona.')
  } else ok('system prompt is replaced', inTok + ' input tokens')

  const ttft = firstChunkAt === null ? null : firstChunkAt
  if (ttft === null) bad('streamed incrementally', 'no text deltas arrived')
  else if (ttft > 5000) {
    bad('first word under 5s', ttft + 'ms to first visible word. Baseline is ~1.9s.')
  } else ok('first word under 5s', ttft + 'ms')

  if (res.rateLimit) {
    const rl = res.rateLimit
    const line = rl.rateLimitType + ' / ' + rl.status +
      (rl.overageStatus ? ' / overage ' + rl.overageStatus : '')
    ok('rate limit info is readable', line)
  } else {
    skip('rate limit info', 'no rate_limit_info on this result')
  }
}

live().then(() => {
  console.log('\n' + '='.repeat(60))
  console.log('  ' + pass + ' passed, ' + fail + ' failed, ' + skipped.length + ' skipped')
  if (!loggedIn) {
    console.log('\n  Live checks need the one time login. From the repo root:')
    console.log('    CLAUDE_CONFIG_DIR="$PWD/relay/.claude-home" claude')
    console.log('  then /login with your PERSONAL account. See relay/README-auth.md.')
  }
  console.log('')
  process.exit(fail > 0 ? 1 : 0)
})
