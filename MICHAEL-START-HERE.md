# oruga-scribe desktop: start here

You click through a task once. It writes the procedure.

This is the desktop recorder. It watches one monitor, captures every click with a screenshot,
reads the name of the control you clicked out of the Windows accessibility tree, and at the end
writes a Standard Operating Procedure. Optionally it turns that document into a narrated video.

There is a separate browser-only version in this repo (`apps/extension`). Ignore it unless the
thing you want to document lives entirely in one Chrome tab.

---

## Before you start

| | |
|---|---|
| Windows | 10 build 2004 or newer. The recording frame uses an API that does not exist before that. |
| .NET Framework | 4.x, which ships with Windows. Nothing to install. |
| Claude Code | Installed and signed in. Run `claude` once and confirm it does not ask you to log in. |
| Node | Only for the video stage. Not needed for the SOP. |

You do **not** need an Anthropic API key. The app has no key and never asks for one. It shells
out to the Claude Code CLI against your own login.

---

## Install

One command, once:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File "<repo>\apps\desktop\install-shortcut.ps1"
```

That puts an `oruga-scribe` icon on your Desktop. That is the whole install.

### Why there is no .exe

There is a compiled binary in the build, and on a machine with Smart App Control enforced it
will not run: Windows blocks a freshly built executable that has no reputation. We hit this and
verified it, including a dll that loaded once and was blocked on the next attempt, which is
worse than a clean refusal.

So the C# is compiled in memory by `powershell.exe`, which Windows already trusts, and the
shortcut points at that launcher. From your side it is still a double click. If you are tempted
to "fix" this by producing a signed exe, that is a real option but it needs a certificate with
accumulated reputation, and none of the code changes.

---

## Record something

1. Double click **oruga-scribe**.
2. Pick a monitor. Each one shows a live thumbnail, so you are not guessing which physical screen
   "Monitor 2" is.
3. Type what you are about to do. This becomes the title of the document, so
   "export a mesh from Blender as glTF" beats "blender stuff".
4. **Start recording.** A red frame appears around that monitor and pulses. A small REC panel
   shows a timer and a step counter.
5. Work normally. Only clicks on the chosen monitor are captured.
6. **Stop.**

The frame and the panel are excluded from screen capture at the compositor level, so you see them
and your screenshots do not. That is verified, not assumed.

### What you get

```
out\session-<timestamp>\
  goal.txt        what you typed
  steps.jsonl     one line per click
  screens\        step-001.png, one per click, the full monitor
  SOP.md          the document
```

---

## Read the tiers before you trust the document

This is the part most people skip and then get surprised by. Open `steps.jsonl` and look at
`tier`:

- **tier 2**: the accessibility tree named the control. `"control": "Save"`. These steps are good.
- **tier 1**: the tree did not answer within 250 ms, or answered with nothing useful. The step
  carries the window, the process and the coordinates, and **no control name**. The recorder
  refuses to invent one, and the SOP marks these as unverified rather than guessing.

`secure` has three values, not two: `NotSecure`, `Secure`, and `Unknown`. Unknown redacts. A query
that returned nothing is not evidence that a field was safe, and treating those as the same thing
is how a redaction gate quietly stops working.

### What predicts a good recording

**Native Windows applications work well.** A File Explorer run came back with 10 of 12 steps
carrying real control names.

**Canvas applications do not.** Blender, games, Flutter, Java Swing and Electron with
accessibility disabled draw their own widgets, so there is nothing at the click point for the
tree to report. A real Blender recording produced 0 of 11 usable names, and 4 clicks blew the
250 ms budget outright.

That is a property of the application you are recording, not a bug in the recorder. If your run
comes back mostly tier 1, the document will be thin, and that is the honest result.

---

## Turn it into a video

```bash
node apps/desktop/bundle-from-session.mjs <session-dir>
```

Run this even if you do not want a video. It writes `bundle.json`, and it rewrites the screenshot
references inside `SOP.md` so they point at files that actually exist. Without it the document
cites `step-01.webp` and your files are `step-001.png`.

Then follow the `/sop-to-video` skill, which handles the voice over and the Remotion render. Two
things from that skill worth knowing up front:

- Run its `--check-auth` first. It is a GET, spends no text-to-speech credits, and settles the
  two things most likely to be wrong: whether the key works and whether the voice exists.
- Watch it in Remotion Studio before rendering. A render is minutes, studio is instant, and the
  problems that actually happen are obvious on sight.

---

## What leaves the machine

Only the goal and one redacted line of text per step, sent to the Claude Code CLI for synthesis.

**Screenshots never leave.** That is deliberate. If pixels were uploaded, the redaction gate could
not be authoritative, because the redaction would be happening after the data was already gone.

The redaction gate runs to completion before anything is composed into a prompt. It applies
fourteen secret patterns plus a Luhn check on card-shaped digit runs, and it withholds any label
whose field was secure or whose status was unknown. If it throws on a step, that step is dropped
rather than sent raw.

---

## When something goes wrong

| What you see | What it is |
|---|---|
| Nothing happens on double click | The launcher hides its console. Errors appear in a message box. If not even that shows, run `run.ps1` from a terminal and read the output. |
| "Claude is not signed in" | `SCRIBE_CLAUDE_CONFIG_DIR` is pointing at a config directory with no session. Unset it, or run `claude` there once and `/login`. |
| The SOP references images that do not exist | You skipped `bundle-from-session.mjs`. |
| Every step is tier 1 | You recorded a canvas application. Expected, not broken. |
| The frame covers part of the screen | It should be a thin border. If it is a wide band, the minimum window size handling regressed. There is a test for it. |

---

## If you change anything

```bash
powershell -NoProfile -ExecutionPolicy Bypass -File test/desktop-scrub.ps1   # 30 asserts
node test/cli-parity.mjs                                                     # 13
node test/scrub-parity.mjs                                                   # 19
node test/harness.mjs                                                        # 39
```

The two parity tests are not ceremony. This repo shipped a redaction list with a missing pattern
once, because the same list existed in two files and they drifted. `scrub-parity` holds the C#
kill list identical to the JavaScript one. `cli-parity` holds the C# spawn contract identical to
`relay/claude.js`, where every one of those flags was measured rather than chosen. Change one
copy and the test tells you about the other.

Every assertion in this project is expected to be falsifiable: if you add one, break the thing it
covers on purpose and confirm it goes red. A test that cannot fail counts as coverage while
providing none.
