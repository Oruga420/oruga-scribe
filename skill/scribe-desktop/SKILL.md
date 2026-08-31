---
name: scribe-desktop
description: Record any Windows application (not just a browser tab) and turn it into a SOP and a narrated video. Launches the oruga-scribe desktop recorder, which asks which monitor to watch, frames it in red while recording, captures every click with a screenshot, writes the SOP through claude -p, builds the /sop-to-video bundle, and hands off to the video pipeline. Use for /scribe-desktop, "record my screen and write the SOP", "graba mi pantalla y hazme la guia", "SOP de una app de escritorio".
---

# /scribe-desktop - record the whole machine, get a SOP and a video

`/scribe` drives a browser tab. This watches **any native Windows application**: Blender, the
File Explorer, an installer, a desktop client. Alejandro clicks, the recorder captures, and the
end of the run is a document plus, if asked, a narrated video.

**You are the operator, not the author.** The recorder captures and `claude -p` synthesises.
Never write the SOP yourself from what you think happened: that discards the screenshots, the
accessibility labels and the redaction gate, and produces a worse artifact that looks the same.

Project root: `C:\Users\chuck\Desktop\oruga-scribe`
App: `apps\desktop\`

## The one thing that makes this app unusual

**It cannot be a .exe on Alejandro's machine.** Smart App Control is enforced
(`VerifiedAndReputablePolicyState = 1`) and blocks a freshly built binary that has no
reputation. A compiled exe and a compiled dll were both blocked, the dll non deterministically,
which is worse than a hard no. So the C# is compiled **in process by powershell.exe**, which
Windows already trusts. `run.ps1` does that, and the desktop shortcut points at it.

Do not try to "fix" this by building an exe. It will compile, and it will not run.

## Arguments

`/scribe-desktop [goal] [--video]`

If no goal was given, **ask for one before launching.** A run without a goal produces a
directionless tour and is not a procedure. A goal looks like "how to export a mesh from Blender
as glTF", not "blender stuff".

`--video` continues into the narrated video after the SOP. Without it, stop at the document and
say the video is one command away.

## Stage 1: record

```bash
powershell -NoProfile -ExecutionPolicy Bypass -File "C:\Users\chuck\Desktop\oruga-scribe\apps\desktop\run.ps1"
```

This BLOCKS until Alejandro presses Stop, which can be many minutes. Launch it in the background
and tell him the recorder is up. Never poll it, never time it out at two minutes and assume it
died.

What he sees: a monitor picker with a live thumbnail of each screen, a goal field, then a red
pulsing frame around the chosen monitor and a small REC panel with a timer and a step count.

What lands on disk, in `out\session-<stamp>\`:

```
goal.txt        what he typed before starting
steps.jsonl     one JSON line per click
screens\        step-001.png ... one per click, the whole monitor
SOP.md          written at Stop, if Claude is signed in
```

### Auth, and the trap

Synthesis runs through `claude -p` against the machine's own web login. There is **no API key**
and the app strips `ANTHROPIC_API_KEY` from the child environment on purpose.

`SCRIBE_CLAUDE_CONFIG_DIR` overrides which login is used. `relay\.claude-home` is the isolated
personal directory and **it has no session**, so pointing at it produces a clean failure that
says "Claude is not signed in" and leaves the recording intact. That is by design, and it has
already been mistaken for a bug twice. If the SOP must be written, do not set that variable.

## Stage 2: read what was actually captured

Before showing Alejandro a document, look at the tiers. This is the difference between a real
guide and a confident-sounding one.

```bash
node -e "const s=require('fs').readFileSync(process.argv[1],'utf8').trim().split('\n').map(JSON.parse);console.log('tier 2:',s.filter(x=>x.tier==='2').length,'of',s.length);console.log('redacted:',s.filter(x=>x.secure!=='NotSecure').length)" <session>/steps.jsonl
```

- **tier 2** means the accessibility tree named the control. These steps are good.
- **tier 1** means it did not answer, so the step carries only the window, the process and
  coordinates. The recorder refuses to invent a name, and so must the SOP.
- **redacted** means the field was secure, or its status could not be established. Unknown fails
  closed and is treated as secret.

**Canvas applications produce almost no tier 2.** Blender, games, Flutter, Java Swing and
Electron with accessibility off draw their own widgets, so UI Automation has nothing at the click
point. Measured on a real Blender recording: 0 of 11 steps carried a usable control name, and 4
blew the 250 ms budget outright. Native Windows apps are the opposite: a File Explorer recording
came back 10 of 12 with real labels.

If a run comes back almost entirely tier 1, **say so before handing over the SOP.** The document
will be thin and that is the honest outcome, not a failure to hide.

## Stage 3: the bundle

```bash
node apps/desktop/bundle-from-session.mjs <session-dir>
```

Writes `bundle.json` in the /sop-to-video contract, and **rewrites the screenshot references
inside SOP.md**. That second part is not cosmetic: the shared prompt
`relay\prompts\sop-system.txt` tells the model to write `step-01.webp` because that is what the
browser front end produces, while the desktop app produces `step-001.png`. Left alone every
desktop SOP cites files that do not exist and the video finds no images at all.

It reports degraded steps, redacted steps, missing screenshots and steps with no SOP prose. Read
that output. It is the honest summary of how good the source material is.

## Stage 4: the video, only with --video

Hand the bundle to `/sop-to-video` and follow that skill. Do not reimplement any of it here.

```bash
SKILL="$HOME/.claude/skills/sop-to-video"
node "$SKILL/scripts/voiceover.mjs" --bundle <session-dir> --check-auth   # spends no credits, run first
node "$SKILL/scripts/voiceover.mjs" --bundle <session-dir>
cd "$SKILL/remotion" && npm install && npm run studio -- --props=<session-dir>/video.json
```

Watch it in studio before rendering. A render is minutes; studio is instant, and the two failures
that actually happen (a caption overflowing, audio out of step with the image) are obvious on
sight and invisible in a manifest.

Rendering on this machine needs the sequence plus system ffmpeg workaround, which is documented
in `/sop-to-video` under Render. Remotion's bundled ffmpeg exits 127 here. Every frame renders
fine; only the stitch fails.

**A degraded step deserves a quieter caption, not an invented one.** `bundle.json` marks each
step with `degraded` and `redacted`. A step with no control name should not get a voice over that
confidently names a button.

## Failure modes worth knowing

| What you see | What it is |
|---|---|
| Nothing happens on double click | The launcher hides its console on purpose. Errors come up in a message box. If not even that appears, run `run.ps1` from a terminal and read the output. |
| "Claude is not signed in" | `SCRIBE_CLAUDE_CONFIG_DIR` points at the empty isolated directory. Unset it, or run `/login` in that directory once. |
| SOP references images that are not there | `bundle-from-session.mjs` was not run. It is what makes the document true. |
| The SOP is one word, like "success" | Should be impossible now, but it is the historical shape: the CLI reply parser matched the VALUE in `{"type":"result"}` instead of the key. Covered by `test/desktop-scrub.ps1`. |
| Every step is tier 1 | Canvas application. Not a bug. Say so. |

## Tests

Run these after touching anything in `apps\desktop\`:

```bash
powershell -NoProfile -ExecutionPolicy Bypass -File test/desktop-scrub.ps1   # 30 asserts
node test/cli-parity.mjs                                                     # 13
node test/scrub-parity.mjs                                                   # 19
node test/harness.mjs                                                        # 39, the extension contract
```

The two parity tests exist because this repo has already shipped a redaction list with a hole in
it. `scrub-parity` holds the C# kill list identical to `relay/scrub.js`; `cli-parity` holds the
C# spawn contract identical to `relay/claude.js`, where every one of those flags was measured
rather than guessed. If you add a pattern or change a flag in one copy, the test tells you about
the other.
