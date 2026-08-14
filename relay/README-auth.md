# Relay auth: isolated personal login

The relay drives the Claude Code CLI. It must NOT use this machine's default login, which is
the Promise Claude Team seat (`dev01@promise.ai`). oruga-scribe is a personal project, so it
gets its own config directory with a personal login.

## How the isolation works

`CLAUDE_CONFIG_DIR` relocates everything the CLI considers "the user": credentials, settings,
session transcripts, project history. Point it at a folder inside this repo and the CLI behaves
like a fresh install that knows nothing about Promise.

Verified on claude 2.1.219, 2026-08-14:

| Config dir | Result |
|---|---|
| default | `is_error: false`, ran on the Promise seat |
| `relay/.claude-home` (empty) | `is_error: true`, `terminal_reason: "api_error"`, 0 tokens, and a fresh `.claude.json` / `projects/` / `sessions/` skeleton was created |

The failure on an empty dir is the proof that it worked. It is not reading the default profile.

`relay/.claude-home/` is gitignored. Credentials never enter the repo.

## One time setup

Run this once, from the repo root, with your PERSONAL Claude account:

```bash
CLAUDE_CONFIG_DIR="$PWD/relay/.claude-home" claude
```

Then `/login` inside that session and pick the personal account. Quit when it says you are
logged in. Every relay call from then on sets the same env var and inherits that login.

Verify with:

```bash
echo "say OK" | CLAUDE_CONFIG_DIR="$PWD/relay/.claude-home" \
  claude -p --model haiku --output-format json | grep -o '"is_error":[a-z]*'
```

`"is_error":false` means the personal login is live.

## Why not the alternatives

- **Accept the Promise seat.** Quota is pooled with interactive Claude Code, and the org has
  `overageStatus: "rejected"` with `overageDisabledReason: "org_level_disabled"`, so hitting the
  five hour window is a hard stop mid recording. It also mixes a personal tool with company
  resources.
- **An Anthropic API key.** Works, isolates spend cleanly, but reintroduces a secret and a
  dollar ledger that this design otherwise does not need.

## Spawn requirements, measured not assumed

Two flags are load bearing. Neither is optional.

**`MAX_THINKING_TOKENS=0` in the child env, narration path only.** Extended thinking is on by
default and is NOT disabled by `--safe-mode`, by `effortLevel` in settings.json, or meaningfully
by `--effort low`.

| | wall | to first visible word | output tokens |
|---|---|---|---|
| thinking on | 10.8 s | 10.4 s | 649 |
| `MAX_THINKING_TOKENS=0` | 3.3 s | 1.9 s | 116 |

Keep thinking ON for SOP synthesis, where quality matters and latency does not.

**`--system-prompt-file` on both paths.** Without it the CLI loads its own agent persona, which
is both expensive and wrong for this job.

| | input tokens | output tokens | api duration |
|---|---|---|---|
| no `--system-prompt-file` | 6,316 (6,206 cache read + 110) | 486 | 6,136 ms |
| with `--system-prompt-file` | 149 | 8 | 2,361 ms |

The output difference is the real point. Without the file you get agent flavored chatter. With
it, the same input returned exactly `Saved the invoice.`

Pass the persona as a FILE, never as an argv value. On Windows the CLI on PATH is a shell script
and `shell:true` lets cmd.exe silently mutilate multiline arguments.

## Do not use --bare

It looks like the ideal isolation flag. It is disqualified here: with `--bare` auth becomes
strictly `ANTHROPIC_API_KEY` or `apiKeyHelper`, and OAuth and the keychain are never read. On a
subscription it hard fails with "Not logged in". Assemble isolation from the granular flags
instead: `--tools=`, `--setting-sources=`, `--strict-mcp-config`, `--disable-slash-commands`.

## Do not trust --safe-mode to pick the model

`--safe-mode` does not override `model: opus[1m]` from settings.json. A run that looked fully
isolated was executing on Opus 5 with a 1M context. Always pass `--model` explicitly, and assert
the model back from the result event.
