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
extension/    MV3 extension. The side panel owns the session state, not the service worker.
relay/        Node server on 127.0.0.1 that spawns claude -p. Holds no Anthropic secret.
out/          Generated SOPs land here. Gitignored.
```

The extension talks only to `http://127.0.0.1:<port>`. It has no internet egress of its own.

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

## Local rules

- Never deploy, publish or push this without an explicit go ahead.
- The relay writes nothing outside this folder except its own scratch config dir.
- Redaction is fail closed. If the scrubber throws, the step is dropped, not sent.
