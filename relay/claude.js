'use strict'

/**
 * relay/claude.js - the only place in oruga-scribe that spawns Claude.
 *
 * Everything in here is load bearing and measured. Before changing a flag, read
 * wiki/measured-baselines.md and wiki/claude-cli-contract.md. Numbers were taken on
 * Windows 11, Node v24.13.0, claude 2.1.219, 2026-08-14.
 *
 * The traps this file exists to avoid:
 *   - MAX_THINKING_TOKENS=0 on narration. Without it: 10.8s instead of 3.3s per call.
 *   - --system-prompt-file on both paths. Without it the CLI answers as its own agent
 *     persona: 486 output tokens of chatter instead of 8 tokens of narration.
 *   - --verbose is REQUIRED with -p plus stream-json or the process exits immediately.
 *   - --model must be explicit. --safe-mode does not override settings.json.
 *   - CLAUDE_CONFIG_DIR must always be set, or the call silently runs on the Promise seat.
 *   - Spawn the native .exe with shell:false. A .cmd through cmd.exe silently mutilates args.
 */

const { spawn, execFile, execFileSync } = require('node:child_process')
const path = require('node:path')
const fs = require('node:fs')

const MODELS = Object.freeze({
  narrate: 'claude-haiku-4-5',
  synthesize: 'claude-sonnet-5',
  synthesizeUpgrade: 'claude-opus-5',
})

const TIMEOUTS = Object.freeze({ narrate: 30_000, synthesize: 300_000 })

/** Planted so a dropped image is detectable. See detectImageFailure(). */
const NO_IMAGE_SENTINEL = 'NO-IMAGE-RECEIVED'

/** The CLI reports a dropped image only inside assistant text, with exit code 0. */
const IMAGE_DROPPED_PHRASE = 'could not be processed and was removed'

// ---------------------------------------------------------------------------
// Executable resolution
// ---------------------------------------------------------------------------

let cachedExe = null

/**
 * Find the NATIVE claude binary. Never the .cmd or the shell script: routing through
 * cmd.exe concatenates args unescaped (DEP0190) and silently corrupts anything multiline.
 */
function resolveExe() {
  if (cachedExe) return cachedExe

  const candidates = []
  if (process.env.CLAUDE_BIN) candidates.push(process.env.CLAUDE_BIN)
  if (process.env.APPDATA) {
    candidates.push(path.join(process.env.APPDATA, 'npm', 'node_modules',
      '@anthropic-ai', 'claude-code', 'bin', 'claude.exe'))
  }
  candidates.push(path.join(process.env.LOCALAPPDATA || '', 'Programs', 'claude', 'claude.exe'))

  for (const c of candidates) {
    if (c && fs.existsSync(c)) {
      cachedExe = c
      return cachedExe
    }
  }

  throw new Error(
    'oruga-scribe: could not find the native claude executable.\n' +
    'Looked in:\n  ' + candidates.filter(Boolean).join('\n  ') + '\n' +
    'Set CLAUDE_BIN to the full path of claude.exe.\n' +
    'Do NOT point it at claude.cmd or the shell script: routing through cmd.exe corrupts arguments.'
  )
}

/**
 * The isolated config dir holding the PERSONAL login. Never the machine default.
 *
 * TRIM the env value. `set X=%VAR%\.claude && node ...` in cmd.exe captures the space before the
 * `&&` INTO the value, so the path becomes "C:\Users\me\.claude " with a trailing space. That
 * directory does not exist, so the CLI reported "not logged in" against a machine that was
 * perfectly logged in, and the only visible symptom was a space at the end of a JSON string.
 * Cost 20 minutes of chasing the wrong thing.
 */
function configDir() {
  const raw = process.env.SCRIBE_CLAUDE_CONFIG_DIR
  const trimmed = raw && raw.trim()
  return trimmed || path.join(__dirname, '.claude-home')
}

let loginCache = { at: 0, value: false }

/** Positive answers are cached long, negative ones short. See isLoggedIn(). */
const LOGIN_TTL_OK = 10 * 60_000
const LOGIN_TTL_FAIL = 20_000

/**
 * Ask the CLI, do not guess from files.
 *
 * The first version checked for `oauthAccount` inside .claude.json, which is wrong: a logged in
 * config does not necessarily carry that key, so /health reported "not logged in" on a config
 * that worked perfectly. `claude auth status` is the authoritative answer.
 *
 * ASYMMETRIC CACHE. The panel polls /health every 5s for as long as it is open, and this spawns
 * a process. A flat 15s TTL meant a claude process was spawned every 15 seconds, forever, for a
 * value that changes maybe once a week. Once logged in, cache for 10 minutes. While NOT logged
 * in, keep checking every 20s so the panel lights up soon after the user finishes /login.
 */
function isLoggedIn() {
  const now = Date.now()
  const ttl = loginCache.value ? LOGIN_TTL_OK : LOGIN_TTL_FAIL
  if (loginCache.at && now - loginCache.at < ttl) return loginCache.value
  let value = false
  try {
    const out = execFileSync(resolveExe(), ['auth', 'status'], {
      env: { ...process.env, CLAUDE_CONFIG_DIR: configDir() },
      encoding: 'utf8',
      timeout: 20_000,
      windowsHide: true,
    })
    value = /"loggedIn"\s*:\s*true/.test(out)
  } catch {
    value = false
  }
  loginCache = { at: now, value }
  return value
}

function assertLoggedIn() {
  const dir = configDir()
  if (!fs.existsSync(path.join(dir, '.claude.json'))) {
    throw new Error(
      'oruga-scribe: the isolated Claude config dir is not set up yet.\n' +
      '  ' + dir + '\n' +
      'Run this once from the repo root and /login with your PERSONAL account:\n' +
      '  CLAUDE_CONFIG_DIR="$PWD/relay/.claude-home" claude\n' +
      'See relay/README-auth.md.'
    )
  }
}

// ---------------------------------------------------------------------------
// Spawn profiles
// ---------------------------------------------------------------------------

const ISOLATION = Object.freeze([
  '--permission-mode', 'dontAsk',
  '--tools=',
  '--strict-mcp-config',
  '--mcp-config', '{"mcpServers":{}}',
  '--setting-sources=',
  '--disable-slash-commands',
])

function promptFile(name) {
  const p = path.join(__dirname, 'prompts', name)
  if (!fs.existsSync(p)) throw new Error('oruga-scribe: missing prompt file ' + p)
  return p
}

/**
 * @param {'narrate'|'synthesize'} profile
 * @param {{upgradeModel?: boolean}} opts
 */
function buildArgs(profile, opts = {}) {
  if (profile === 'narrate') {
    return [
      '-p',
      // stream-json input is what carries base64 image blocks. --verbose is mandatory
      // alongside -p + stream-json output or the process exits immediately.
      '--input-format', 'stream-json',
      '--output-format', 'stream-json',
      '--verbose',
      '--include-partial-messages',
      '--model', MODELS.narrate,
      ...ISOLATION,
      '--system-prompt-file', promptFile('narrate-system.txt'),
    ]
  }
  if (profile === 'synthesize') {
    return [
      '-p',
      '--output-format', 'json',
      '--verbose',
      '--model', opts.upgradeModel ? MODELS.synthesizeUpgrade : MODELS.synthesize,
      ...ISOLATION,
      '--system-prompt-file', promptFile('sop-system.txt'),
      // No dollars are billed on a subscription, but this bounds runaway token spend
      // against the shared five hour quota window.
      '--max-budget-usd', '1.00',
    ]
  }
  throw new Error('oruga-scribe: unknown spawn profile ' + profile)
}

function buildEnv(profile) {
  const env = { ...process.env, CLAUDE_CONFIG_DIR: configDir() }

  // Belt and braces: if an API key is present in the parent env it would override the
  // subscription login and start billing. This project never uses one.
  delete env.ANTHROPIC_API_KEY
  delete env.ANTHROPIC_AUTH_TOKEN

  // The single biggest latency win on the narration path. Thinking stays ON for
  // synthesis, where quality matters and latency does not.
  if (profile === 'narrate') env.MAX_THINKING_TOKENS = '0'

  return env
}

// ---------------------------------------------------------------------------
// Message construction
// ---------------------------------------------------------------------------

/**
 * Build one JSONL line for stream-json input.
 * Images ride inline as base64. No Read tool, no disk, no cwd side effects.
 *
 * @param {string} text
 * @param {{base64: string, mediaType: string}|null} image
 */
function buildUserMessage(text, image = null) {
  const content = []
  if (image) {
    content.push({
      type: 'image',
      source: { type: 'base64', media_type: image.mediaType, data: image.base64 },
    })
    content.push({
      type: 'text',
      text: 'If the image above is missing or unreadable, reply with exactly ' +
        NO_IMAGE_SENTINEL + ' and nothing else.',
    })
  }
  content.push({ type: 'text', text })
  return JSON.stringify({ type: 'user', message: { role: 'user', content } })
}

/**
 * A dropped image fails SILENTLY: exit 0, subtype success, is_error false, empty stderr.
 * The only evidence is inside the assistant text. Both halves of this check are needed.
 */
function detectImageFailure(text) {
  if (!text) return false
  // `includes`, not an equality check on the trimmed text. The model was instructed to reply
  // with the sentinel "and nothing else", but a trailing period or a wrapping sentence is well
  // within normal behavior, and an exact match would miss it. On a SAFETY check, prefer the
  // false positive: narrating a step without its image is recoverable, narrating from an image
  // that was never received is not.
  return text.includes(IMAGE_DROPPED_PHRASE) || text.includes(NO_IMAGE_SENTINEL)
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

/**
 * Spawn one call and resolve when the process closes.
 *
 * @param {'narrate'|'synthesize'} profile
 * @param {string} stdinPayload  a JSONL line for narrate, plain text for synthesize
 * @param {object} [opts]
 * @param {(chunk: string) => void} [opts.onDelta]  visible text only, thinking filtered out
 * @param {AbortSignal} [opts.signal]
 * @param {boolean} [opts.hasImage]
 * @param {boolean} [opts.upgradeModel]
 */
function run(profile, stdinPayload, opts = {}) {
  assertLoggedIn()
  const exe = resolveExe()
  const args = buildArgs(profile, opts)
  const env = buildEnv(profile)
  const timeoutMs = TIMEOUTS[profile]

  return new Promise((resolve, reject) => {
    const started = process.hrtime.bigint()
    const elapsed = () => Number(process.hrtime.bigint() - started) / 1e6

    const child = spawn(exe, args, {
      shell: false,           // never true: cmd.exe corrupts args
      windowsHide: true,
      env,
      // A dedicated cwd keeps the child from adopting the repo as a Claude Code project.
      cwd: __dirname,
      stdio: ['pipe', 'pipe', 'pipe'],
    })

    let stdoutBuf = ''
    let stderr = ''
    let streamedText = ''      // from stream_event text deltas
    let assistantText = ''     // from complete assistant messages
    let resultEvent = null
    let initAtMs = null
    let firstTextAtMs = null
    let settled = false

    const timer = setTimeout(() => {
      if (settled) return
      kill(child)
      finish(new Error(
        'oruga-scribe: ' + profile + ' call timed out after ' + timeoutMs + 'ms'
      ))
    }, timeoutMs)

    const onAbort = () => { kill(child); finish(new Error('aborted')) }
    if (opts.signal) {
      if (opts.signal.aborted) return onAbort()
      opts.signal.addEventListener('abort', onAbort, { once: true })
    }

    function finish(err, value) {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (opts.signal) opts.signal.removeEventListener('abort', onAbort)
      err ? reject(err) : resolve(value)
    }

    function handleEvent(ev) {
      // Streaming input mode emits system/init PER TURN, not once per process.
      if (ev.type === 'system' && ev.subtype === 'init' && initAtMs === null) {
        initAtMs = elapsed()
      }
      if (ev.type === 'stream_event') {
        // Subagent output would arrive with a parent_tool_use_id. Tools are off, but
        // guard anyway so a future change cannot leak nested text into the panel.
        if (ev.parent_tool_use_id != null) return
        const e = ev.event
        if (e && e.type === 'content_block_delta' && e.delta) {
          // ONLY text_delta. thinking_delta and signature_delta are not visible output,
          // and counting them is exactly the error that hid the thinking latency problem.
          if (e.delta.type === 'text_delta' && typeof e.delta.text === 'string') {
            if (firstTextAtMs === null) firstTextAtMs = elapsed()
            streamedText += e.delta.text
            if (opts.onDelta) opts.onDelta(e.delta.text)
          }
        }
        return
      }
      if (ev.type === 'assistant' && ev.message && Array.isArray(ev.message.content)) {
        for (const block of ev.message.content) {
          if (block.type === 'text' && typeof block.text === 'string') {
            assistantText += block.text
          }
        }
        return
      }
      if (ev.type === 'result') resultEvent = ev
    }

    // Two output shapes, two readers.
    //   narrate   --output-format stream-json  -> NDJSON, one event per line, read as it streams
    //   synthesize --output-format json        -> ONE JSON document, possibly pretty printed
    //
    // The first version line-split both. For the json profile that consumed a pretty printed
    // document line by line, failed to parse each fragment, and reported "returned no text"
    // on an exit code 0 run that had actually produced the whole SOP.
    const isNdjson = profile === 'narrate'

    child.stdout.on('data', (d) => {
      stdoutBuf += d
      if (!isNdjson) return       // accumulate, parse once at close
      let nl
      while ((nl = stdoutBuf.indexOf('\n')) >= 0) {
        const line = stdoutBuf.slice(0, nl)
        stdoutBuf = stdoutBuf.slice(nl + 1)
        if (!line.trim()) continue
        let ev
        try { ev = JSON.parse(line) } catch { continue }
        try { handleEvent(ev) } catch { /* never let a bad event kill the call */ }
      }
    })

    child.stderr.on('data', (d) => { stderr += d })

    child.on('error', (e) => finish(
      new Error('oruga-scribe: failed to spawn ' + exe + ': ' + e.message)
    ))

    child.on('close', (code) => {
      const leftover = stdoutBuf.trim()
      if (!resultEvent && leftover) {
        // Whole document first. If --verbose printed anything alongside it, fall back to the
        // outermost {...} span rather than giving up and reporting an empty result.
        let parsed = null
        try { parsed = JSON.parse(leftover) } catch { /* try harder below */ }
        if (!parsed) {
          const a = leftover.indexOf('{')
          const b = leftover.lastIndexOf('}')
          if (a >= 0 && b > a) {
            try { parsed = JSON.parse(leftover.slice(a, b + 1)) } catch { /* give up */ }
          }
        }
        // `--output-format json --verbose` emits a JSON ARRAY of events, not one result
        // object. The first version parsed the array fine and then handed the whole array to
        // handleEvent, which found no .type on it and dropped a SOP that had been generated
        // perfectly. Exit code 0, real output, reported as "returned no text".
        if (Array.isArray(parsed)) {
          for (const ev of parsed) {
            try { handleEvent(ev) } catch { /* ignore one bad event */ }
          }
        } else if (parsed) {
          try { handleEvent(parsed) } catch { /* ignore */ }
        }
      }

      // Empty results happen. Three way fallback before giving up.
      const text = (resultEvent && typeof resultEvent.result === 'string' && resultEvent.result.trim())
        || assistantText.trim()
        || streamedText.trim()
        || ''

      if (!text) {
        return finish(new Error(
          'oruga-scribe: ' + profile + ' returned no text (exit ' + code + ')' +
          (stderr.trim() ? '\nstderr: ' + stderr.trim().slice(0, 500) : '')
        ))
      }

      const imageFailed = opts.hasImage ? detectImageFailure(text) : false

      finish(null, {
        text,
        imageFailed,
        exitCode: code,
        stderr: stderr.trim(),
        // Top level usage is PER TURN. modelUsage is cumulative per session and would
        // massively over count if used for per call accounting.
        usage: (resultEvent && resultEvent.usage) || null,
        rateLimit: (resultEvent && resultEvent.rate_limit_info) || null,
        model: resultEvent && resultEvent.modelUsage
          ? Object.keys(resultEvent.modelUsage)
          : [],
        timing: {
          initMs: initAtMs,
          firstTextMs: firstTextAtMs,
          totalMs: elapsed(),
          apiMs: resultEvent ? resultEvent.duration_api_ms : null,
        },
      })
    })

    child.stdin.on('error', () => { /* closed early, the close handler reports it */ })
    child.stdin.write(stdinPayload.endsWith('\n') ? stdinPayload : stdinPayload + '\n')
    child.stdin.end()
  })
}

/** Kill the whole tree. On Windows a plain kill leaves the child running. */
function kill(child) {
  if (!child || child.killed || child.pid == null) return
  if (process.platform === 'win32') {
    execFile('taskkill', ['/pid', String(child.pid), '/T', '/F'], () => {})
  } else {
    child.kill('SIGKILL')
  }
}

/**
 * A throwaway call at record start so the first real narration does not pay the cold
 * binary load. Cold start is 1.35 to 1.9s with the 265MB binary warm in the OS cache,
 * and materially worse right after a reboot or a Claude Code auto update.
 */
async function warmUp() {
  try {
    await run('narrate', buildUserMessage('Reply with the single word: ready.'), {})
    return true
  } catch {
    return false
  }
}

module.exports = {
  run,
  warmUp,
  isLoggedIn,
  buildUserMessage,
  detectImageFailure,
  resolveExe,
  configDir,
  MODELS,
  NO_IMAGE_SENTINEL,
}
