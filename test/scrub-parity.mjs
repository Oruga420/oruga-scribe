/**
 * test/scrub-parity.mjs - the kill list may not drift again.
 *
 *   node test/scrub-parity.mjs
 *
 * There are now THREE copies of the secret pattern list: relay/scrub.js,
 * apps/extension/lib/schema.js (the scrubUrl kill list, covered by harness D6/D6b) and
 * apps/desktop/Scrub.cs. The first two DID drift once: the extension copy was missing `email`,
 * and nothing noticed, because a redaction list with a hole still reads as coverage.
 *
 * This asserts the C# copy against the JS original by parsing both. It is deliberately a
 * comparison of the PATTERN TEXT, not of behaviour, because two regexes that differ by one
 * character are already a bug even if a sample string happens to match both.
 *
 * Falsifiable on purpose: delete any line from SecretPatterns in Scrub.cs and this goes red.
 */

import fs from 'node:fs'
import path from 'node:path'

const ROOT = path.join(import.meta.dirname, '..')
let pass = 0, fail = 0
const failures = []

function ok(name, detail) { pass++; console.log('  PASS  ' + name + (detail ? '   ' + detail : '')) }
function bad(name, why) { fail++; failures.push(name); console.log('  FAIL  ' + name + '\n        ' + why) }

/** Pulls the regex source and replacement out of relay/scrub.js SECRET_PATTERNS. */
function jsPatterns() {
  const src = fs.readFileSync(path.join(ROOT, 'relay', 'scrub.js'), 'utf8')
  // Slice to the array's own closing bracket, which is the first ']' at the start of a line.
  // Searching for the first ']' anywhere finds the one inside [\w.+-] in the very first regex
  // and silently yields an empty block, which then reads as "the JS list is empty".
  const start = src.indexOf('const SECRET_PATTERNS')
  const end = src.indexOf(String.fromCharCode(10) + ']', start)
  const block = src.slice(start, end < 0 ? src.length : end)
  const out = []
  // [/regex/flags, 'replacement'],  with the comment lines skipped
  const re = /\[\s*\/((?:\\.|\[(?:\\.|[^\]])*\]|[^/\\])+)\/([gimsuy]*)\s*,\s*'([^']*)'\s*\]/g
  let m
  while ((m = re.exec(block)) !== null) out.push({ source: m[1], flags: m[2], to: m[3] })
  return out
}

/** Pulls the same out of the C# P(...) calls in apps/desktop/Scrub.cs. */
function csPatterns() {
  const src = fs.readFileSync(path.join(ROOT, 'apps', 'desktop', 'Scrub.cs'), 'utf8')
  const start = src.indexOf('SecretPatterns = new[]')
  const block = src.slice(start, src.indexOf('};', start))
  const out = []
  // P(@"pattern", "replacement")  or  P(@"pattern", "replacement", true)
  const re = /P\(\s*@"((?:[^"]|"")*)"\s*,\s*"((?:\\.|[^"\\])*)"\s*(?:,\s*(true|false)\s*)?\)/g
  let m
  while ((m = re.exec(block)) !== null) {
    out.push({ source: m[1].replace(/""/g, '"'), ignoreCase: m[3] === 'true', to: m[2] })
  }
  return out
}

const js = jsPatterns()
const cs = csPatterns()

console.log('\n  kill list parity: relay/scrub.js vs apps/desktop/Scrub.cs\n')

if (js.length === 0) bad('the JS list was parsed', 'found 0 patterns in relay/scrub.js, the parser is broken not the code')
else ok('the JS list was parsed', js.length + ' patterns')

if (cs.length === 0) bad('the C# list was parsed', 'found 0 patterns in apps/desktop/Scrub.cs')
else ok('the C# list was parsed', cs.length + ' patterns')

if (js.length !== cs.length) {
  bad('both lists have the same length', 'js has ' + js.length + ', c# has ' + cs.length)
} else {
  ok('both lists have the same length', String(js.length))
}

const n = Math.min(js.length, cs.length)
for (let i = 0; i < n; i++) {
  const a = js[i], b = cs[i]
  if (a.source !== b.source) {
    bad('pattern ' + (i + 1) + ' is identical', 'js:  ' + a.source + '\n        c#:  ' + b.source)
  } else if (a.to !== b.to) {
    bad('pattern ' + (i + 1) + ' replaces with the same token', 'js: ' + a.to + '   c#: ' + b.to)
  } else if (a.flags.includes('i') !== b.ignoreCase) {
    bad('pattern ' + (i + 1) + ' agrees on case sensitivity',
        'js flags "' + a.flags + '" vs c# ignoreCase=' + b.ignoreCase)
  } else {
    ok('pattern ' + (i + 1) + ' matches', a.to)
  }
}

// The one that actually drifted last time. Named explicitly so a future reader sees why.
const hasEmail = (list, key) => list.some((p) => p.to === '[email]')
if (!hasEmail(js)) bad('the JS list still covers email', 'this is the exact pattern that went missing before')
else ok('the JS list still covers email')
if (!hasEmail(cs)) bad('the C# list still covers email', 'this is the exact pattern that went missing before')
else ok('the C# list still covers email')

console.log('\n' + '='.repeat(62))
console.log('  ' + pass + ' passed, ' + fail + ' failed')
if (fail > 0) {
  console.log('\n  failing: ' + failures.join(', '))
  process.exit(1)
}
console.log('  kill lists are identical')
