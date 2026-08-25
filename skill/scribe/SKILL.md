---
name: scribe
description: Record a web tool by driving it yourself and produce a SOP. Runs the local oruga-scribe extension in Chrome for Testing over CDP, clicks through the tool as the agent, and lets the extension capture and the relay synthesize the guide. Use for /scribe <url>.
---

# /scribe - write a SOP by driving the tool yourself

Alejandro built oruga-scribe so that clicking through a tool produces a SOP. This skill makes
**you** the hands instead of his mouse. You drive real clicks, the extension records them
exactly as it records a human, and the relay writes the guide.

**You are the hands, not the author.** Do not read the DOM and write a guide yourself. That
throws away the screenshots, the settle timing and the redaction gate, and produces a
different, worse artifact. The extension records; the relay synthesizes; you only decide
where to click.

Project root: `C:\Users\chuck\Desktop\oruga-scribe`

## Arguments

`/scribe <url> [goal]`

If no goal was given, **ask for one before launching.** A run without a goal produces a
directionless tour of the UI, which is not a procedure and nobody reads it. A goal looks
like "how to rotate the Slack bot token" or "how to add a new user and assign a role".

## Preflight

1. **The relay must be running**, because synthesis goes through it:
   `curl -s http://127.0.0.1:8787/health`
   If it is down, start it: `node relay/server.js` from the project root, in the background.
2. **Chrome for Testing must exist.** If the driver reports it missing, the one time install is
   `cd .tools && npx playwright install chromium`.

## Run

Start the driver in the background from the project root:

```
node auto/driver.mjs --url "<url>" --goal "<goal>"
```

Add `--user-data-dir "<path>"` to reuse a Chrome profile that is already logged in.
Add `--company promise` only if the tool being documented is a Promise tool.

Wait for `control API on http://127.0.0.1:8788` in its output, then work through the API with
`curl`. Every response is JSON with an `ok` field.

| Call | What it does |
|---|---|
| `GET /state` | recording flag, step count, current url |
| `GET /survey` | every visible interactive control: `i`, `name`, `role`, `risk`, `secret` |
| `POST /start` | fills the panel's goal, clicks the real Start button, opens the session |
| `POST /click` `{i}` or `{name}` | a real mouse click. Returns `recorded` and a fresh survey |
| `POST /type` `{i, text}` | click then type. Refuses credential fields |
| `POST /navigate` `{url}` | go somewhere else |
| `POST /shot` `{name}` | a debug screenshot into `out/_auto-shots/` |
| `POST /finish` | stops the recording and sends the session to the relay for synthesis |
| `POST /quit` | closes the browser |

## The loop

1. `GET /survey` and read what the page actually offers.
2. Pick the ONE control that advances the goal. Say why in one line before you click it.
3. `POST /click`.
4. Read `recorded` in the response. Continue.

Stop when the goal is achieved, then `POST /finish`, then `POST /quit`.

## Rules that are not optional

**Never click something the driver flags as risky.** A response with `blocked: true` means the
control's name matched the destructive denylist (delete, send, pay, publish, deactivate, and
so on). Do not retry with `confirm: true` on your own judgement. **Stop, tell Alejandro exactly
which control and what the guide needs it for, and wait for his answer.** A SOP is not worth a
destroyed record or a sent message. If a flagged control is genuinely just navigation and the
match was a false positive, say so when you ask, and let him decide.

**Never type a credential.** `POST /type` refuses password and card fields. If the tool needs a
login, stop and ask Alejandro to log in himself in the browser window the driver already
opened, then continue. Do not look for a way around this.

**`recorded: false` is a real failure, not noise.** It means the click landed but the extension
captured nothing, so that step will be missing from the guide with no other symptom. This
codebase's characteristic failure is returning success while broken, and ten of its twenty two
known bugs did exactly that. If a click does not record, retry it once, and if it still does
not, say so plainly rather than continuing and shipping a guide with a hole in it.

**Keep it short enough to be a procedure.** Eight to twenty steps is a guide. Sixty clicks is a
tour. Prune as you go by not clicking things the goal does not need.

**Do not enter data that will persist** unless Alejandro asked for it. Filling a form is fine
if you never submit it; the guide can say "fill these fields and press Save" without you
pressing Save.

## When you are done

The relay writes the SOP under `out/<company>/<timestamp>/`. Report the path, the step count,
and anything the run could not cover. If any click failed to record, or you skipped a step
because it was blocked, say so in the report. Do not describe the guide as complete when a
step is missing.

## Known platform facts, so you do not rediscover them

- **Playwright's launcher cannot be used.** `chromium.launch` and `launchPersistentContext`
  inject `--disable-extensions`, which silently defeats the extension. The driver spawns the
  browser itself and uses Playwright only as a CDP client. Proven here by reading
  `chrome://version` inside a launched browser.
- **Branded Chrome ignores `--load-extension` entirely.** Verified via
  `chrome://extensions-internals`, which listed only COMPONENT extensions. Must be Chrome for
  Testing.
- **The recording has to start by clicking the panel's real Start button.** Starting it with a
  runtime message leaves the panel's own session variable null, so the live step list never
  renders. The driver already does this correctly; do not try to start a session by message.
- Screenshot capture is capped at two per second by Chrome, and the capture pipeline waits for
  a quiet MutationObserver with a 2.5 s ceiling. The driver already paces clicks for this.
  Clicking faster than the driver does will drop steps.
