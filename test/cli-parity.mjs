/**
 * test/cli-parity.mjs - the spawn contract may not drift either.
 *
 *   node test/cli-parity.mjs
 *
 * relay/claude.js is where every one of these flags was MEASURED rather than guessed, and the
 * measurements are in wiki/measured-baselines.md. apps/desktop/ClaudeCli.cs is a second copy of
 * the same contract for a front end that has no Node in it. Two copies of one contract drift.
 * This repo already paid for that lesson once with the redaction kill list, which is why
 * scrub-parity.mjs exists; this is the same lock on the same shape of problem.
 *
 * Falsifiable on purpose: change any flag in either file and this goes red.
 */

import fs from 'node:fs'
import path from 'node:path'

const ROOT = path.join(import.meta.dirname, '..')
const NL = String.fromCharCode(10)
let pass = 0, fail = 0
const failures = []

function ok(name, detail) { pass++; console.log('  PASS  ' + name + (detail ? '   ' + detail : '')) }
function bad(name, why) { fail++; failures.push(name); console.log('  FAIL  ' + name + NL + '        ' + why) }

const js = fs.readFileSync(path.join(ROOT, 'relay', 'claude.js'), 'utf8')
const cs = fs.readFileSync(path.join(ROOT, 'apps', 'desktop', 'ClaudeCli.cs'), 'utf8')

/** Every quoted string inside a named block, in order. */
function strings(src, startMarker, endMarker, quote) {
  const start = src.indexOf(startMarker)
  if (start < 0) return null
  const end = src.indexOf(endMarker, start)
  const block = src.slice(start, end < 0 ? src.length : end)
  const out = []
  const re = quote === "'" ? /'((?:\\.|[^'\\])*)'/g : /"((?:\\.|[^"\\])*)"/g
  let m
  while ((m = re.exec(block)) !== null) out.push(m[1])
  return out
}

console.log(NL + '  spawn contract parity: relay/claude.js vs apps/desktop/ClaudeCli.cs' + NL)

// ---- the isolation flags -----------------------------------------------------------------
const jsIso = strings(js, 'const ISOLATION = Object.freeze([', '])', "'")
const csIso = strings(cs, 'public static readonly string[] Isolation', '};', '"')
  .map((s) => s.replace(/\\"/g, '"'))

if (!jsIso) bad('the JS isolation block was found', 'ISOLATION not found in relay/claude.js')
else if (!csIso) bad('the C# isolation block was found', 'Isolation not found in ClaudeCli.cs')
else if (jsIso.length !== csIso.length) {
  bad('isolation flags have the same count', 'js ' + jsIso.length + ', c# ' + csIso.length +
      NL + '        js:  ' + jsIso.join(' ') + NL + '        c#:  ' + csIso.join(' '))
} else {
  let same = true
  for (let i = 0; i < jsIso.length; i++) {
    if (jsIso[i] !== csIso[i]) {
      bad('isolation flag ' + (i + 1) + ' matches', 'js "' + jsIso[i] + '" vs c# "' + csIso[i] + '"')
      same = false
    }
  }
  if (same) ok('all isolation flags match, in order', jsIso.length + ' tokens')
}

// ---- the synthesize model ----------------------------------------------------------------
const jsModel = (js.match(/synthesize:\s*'([^']+)'/) || [])[1]
const csModel = (cs.match(/public const string Model = "([^"]+)"/) || [])[1]
if (!jsModel || !csModel) bad('both files name a synthesis model', 'js=' + jsModel + ' c#=' + csModel)
else if (jsModel !== csModel) bad('the synthesis model matches', 'js ' + jsModel + ', c# ' + csModel)
else ok('the synthesis model matches', jsModel)

// ---- the flags the synthesize profile must carry -------------------------------------------
// Named one by one rather than diffed as a blob, so a failure says WHICH flag went missing and
// the comment explains why that flag is load bearing.
const required = [
  ['-p', 'the print mode the whole contract is built on'],
  ['--output-format', 'json is what makes the reply parseable'],
  ['--verbose', 'mandatory alongside -p, without it the process exits immediately'],
  ['--model', 'never left implicit'],
  ['--system-prompt-file', 'a FILE, never an argv value'],
  ['--max-budget-usd', 'bounds runaway spend against the five hour quota window'],
]
for (const [flag, why] of required) {
  const inJs = js.includes("'" + flag + "'")
  const inCs = cs.includes('"' + flag + '"')
  if (inJs && inCs) ok('synthesize carries ' + flag, why)
  else bad('synthesize carries ' + flag, 'js=' + inJs + ' c#=' + inCs + '   (' + why + ')')
}

// ---- the environment rules ------------------------------------------------------------------
for (const key of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN']) {
  const jsDrops = js.includes('delete env.' + key)
  const csDrops = cs.includes('Remove("' + key + '")')
  if (jsDrops && csDrops) ok('both strip ' + key + ' from the child environment')
  else bad('both strip ' + key + ' from the child environment', 'js=' + jsDrops + ' c#=' + csDrops)
}

// ---- thinking stays ON on synthesis ----------------------------------------------------------
// The narration path sets MAX_THINKING_TOKENS=0 and synthesis deliberately does not. The desktop
// app has no narration path at all, so it must not set it anywhere.
if (cs.includes('MAX_THINKING_TOKENS')) {
  bad('the desktop app never disables thinking',
      'ClaudeCli.cs mentions MAX_THINKING_TOKENS. Thinking stays ON for synthesis, where quality matters and latency does not')
} else {
  ok('the desktop app never disables thinking', 'synthesis keeps it on, by design')
}

// ---- never route through the shell -----------------------------------------------------------
if (cs.includes('UseShellExecute = false')) ok('the desktop spawn never goes through a shell')
else bad('the desktop spawn never goes through a shell',
         'cmd.exe concatenates args unescaped and silently mutilates multiline content')

if (cs.includes('claude.cmd') && !cs.includes('Do NOT point it at claude.cmd')) {
  bad('the desktop app resolves the native exe', 'it references claude.cmd outside of the warning')
} else {
  ok('the desktop app resolves the native exe', 'never the .cmd wrapper')
}

console.log(NL + '='.repeat(62))
console.log('  ' + pass + ' passed, ' + fail + ' failed')
if (fail > 0) {
  console.log(NL + '  failing: ' + failures.join(', '))
  process.exit(1)
}
console.log('  the two copies of the spawn contract agree')
