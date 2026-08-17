# Build contract

The loop condition: **keep going until every check below passes.** Not "until the code looks
right", not "until it parses". Until it demonstrably works.

Written 2026-08-17 after the first real load failed: pressing record did not record, and stop
showed an empty review.

## Acceptance criteria

Each one is either machine verified by `node test/harness.mjs`, or verified by Alejandro
clicking. No criterion is satisfied by reading the source.

### A. Recording survives the service worker

| # | Check | How verified | Status |
|---|---|---|---|
| A1 | A step is captured immediately after pressing record | harness | PASS |
| A2 | A step is still captured after the service worker has been killed and revived | harness | PASS |
| A3 | Session state is read from IndexedDB, never from a worker global | harness asserts no global is required | PASS |
| A4 | Every step is in IndexedDB before the panel is told about it | harness | PASS |

**Root cause of the first failure:** `live` was a module global in `sw.js`. MV3 terminates the
worker after 30 seconds idle and takes every global with it, so the first pause in clicking
silently ended the recording. This is the exact risk the plan lists first, and the first
implementation violated it.

### B. It attaches to the tab you are already on

| # | Check | How verified | Status |
|---|---|---|---|
| B1 | Recording works on a tab that was already open before the extension loaded, with no reload | harness plus Alejandro | PASS in harness |
| B2 | If a frame genuinely cannot be reached, the panel says so instead of appearing to work | Alejandro | |
| B3 | Restricted pages are refused with a clear reason | harness plus Alejandro | PASS in harness |

### C. The review screen shows what was recorded

| # | Check | How verified | Status |
|---|---|---|---|
| C1 | After stop, every unpruned step is listed with its label | harness plus Alejandro | PASS in harness |
| C2 | Each step shows its screenshot thumbnail | Alejandro | |
| C3 | Steps can be pruned, and pruned steps do not reach the model | harness | PASS |
| C4 | An empty review says why it is empty rather than showing a blank pane | Alejandro | built, needs your eyes |

### D. Nothing leaks

| # | Check | How verified | Status |
|---|---|---|---|
| D1 | Password field values never appear in the payload | harness | PASS |
| D2 | Tokens, keys, JWTs, emails, Luhn valid cards are redacted from every string | harness | PASS |
| D3 | Flagged regions are painted solid black in the model frame, not blurred | harness | PASS |
| D4 | A payload the scrubber cannot process is dropped, never sent raw | harness | PASS |

### E. It writes the thing

| # | Check | How verified | Status |
|---|---|---|---|
| E1 | Relay answers `/health` and reports login state honestly | done, verified | PASS |
| E2 | A foreign origin gets 403 | done, verified | PASS |
| E3 | Live narration appears in the panel during recording | Alejandro, needs login |  |
| E4 | Stop then "Write the SOP" produces a Markdown file in `out/` | Alejandro, needs login | |

### F. The deliverable

| # | Check | Status |
|---|---|---|
| F1 | A saved SOP for how to use Delphi, tagged personal, recorded from the real site | |

## Known blocker, owned by Alejandro

Criteria E3, E4 and F1 cannot pass until the isolated config dir has a personal login. Everything
in A through D is independent of it and must pass first.

```
CLAUDE_CONFIG_DIR="$PWD/relay/.claude-home" claude auth login
```

## One flag on F1

Delphi is a Promise tool. Tagging its SOP `personal` puts Promise screenshots into the personal
output folder, which is the exact thing the company tag exists to prevent. Doing it as asked, and
noting it here so the choice is on the record rather than buried in a chat.
