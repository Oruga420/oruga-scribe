# oruga-scribe

A Chrome extension that watches you click through a web tool and writes the SOP.

You state a goal, hit record, and work normally. The extension captures each meaningful
interaction, screenshots the state before each click, streams written narration into a side
panel while you go, optionally speaks it, and at the end produces a finished Standard
Operating Procedure as an editorial HTML page plus Markdown.

Personal project. Local and single user by construction.

## Status

Phase 0. Scaffolding. Nothing runs yet.

The plan lives in [ultraplan.html](./ultraplan.html), rev 2.1. Open it in a browser.
It is the source of truth for architecture, measured numbers, risks and phase order.

## Shape

```
apps/extension/   MV3 extension. The side panel owns the session state, not the service worker.
apps/desktop/     The desktop recorder. Same product, native apps instead of one browser tab.
core/             Shared between both front ends. The step schema lives here.
relay/            Node server on 127.0.0.1 that spawns claude -p. Holds no Anthropic secret.
                  Shared by both apps, and deliberately NOT under apps/.
out/              Generated SOPs land here. Gitignored.
```

Both front ends talk only to `http://127.0.0.1:<port>`. Neither has internet egress of its own.

`relay/` stays at the root on purpose. It is the shared backend, and moving it would stop
`.gitignore`'s `relay/.claude-home/` line matching, which would make the OAuth config
directory trackable.

## Auth

No Anthropic API key. The relay drives the already logged-in Claude Code CLI.

It runs against an **isolated config directory with a personal login**, not the machine's
default profile, so a personal tool never spends Promise company quota. See
`relay/README-auth.md` for the one time setup.

The only API key in the project is ElevenLabs, for optional voice.

## The one thing that matters most

`MAX_THINKING_TOKENS=0` in the child environment on the narration path.

Extended thinking is on by default and it is not disabled by `--safe-mode`, not by
`effortLevel` in settings.json, and only weakly by `--effort low`. On a transcription task it
burned about 2.5 seconds and 540 of 649 output tokens per call. Turning it off took a
narration call from 10.8 seconds to 3.3, and time to first visible word from 10.4 to 1.9.

Keep thinking ON for the end of session SOP synthesis, where quality matters and latency
does not.

## Driving it yourself: `/scribe`

`auto/driver.mjs` lets an agent be the hands instead of a human mouse. It spawns Chrome for
Testing with the extension loaded, starts a real recording, and exposes a loopback control API
so the agent can survey the page, click, type and finish. **The extension is still the
recorder and the relay still writes the SOP**; the agent only decides where to click. Reading
the DOM and writing a guide directly would throw away the screenshots, the settle timing and
the redaction gate.

```
node relay/server.js                                     # synthesis goes through it
node auto/driver.mjs --url "<url>" --goal "<what to teach>"
```

Then talk to `http://127.0.0.1:8788`: `GET /survey`, `POST /start`, `POST /click`,
`POST /type`, `POST /finish`, `POST /quit`. Add `--user-data-dir` to reuse a profile that is
already logged in.

Two refusals are built in and are the point of the file. A control whose accessible name
matches the destructive denylist (delete, send, pay, publish, deactivate, and the Spanish
equivalents) is refused unless the caller passes `confirm: true`, and credential fields refuse
typing outright. A human knows not to press Delete; an agent does not, and a SOP is not worth
a destroyed record.

`auto/fixture/` is a local fake admin console for exercising all of this without touching a
real tool or the network.

**The skill lives in `skill/scribe/`.** To use it, copy it where Claude Code looks for skills:

```
cp -r skill/scribe ~/.claude/skills/
```

## Local rules

- Never deploy, publish or push this without an explicit go ahead.
- The relay writes nothing outside this folder except its own scratch config dir.
- Redaction is fail closed. If the scrubber throws, the step is dropped, not sent.
