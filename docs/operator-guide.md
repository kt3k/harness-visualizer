# Operator guide: making a controlled change and verifying it

This walks through a real change on the bundled fixtures: **the coding agent must never
`git push --force`, and must not read `.env` files.** The same steps apply to your harness.

## 0. Read "What it does" (S) first

The landing page tells you, in plain language, what starts each agent, what it does step by
step, which tools the model can pick (with what each one really does and what stops it), what
the harness touches, how runs end, and — first — what to watch out for. Every line links to
its evidence; the graph views below are for drilling in.

## 0b. Orient (Map, A)

Open the harness. The architecture view shows agents, subagents, tool sets, stores and entry
points; the *Findings* panel lists what deserves attention first. For `coding-agent`:

* 3 prompt rules with no matching code guard (advisory only)
* 2 operations whose behavior is unknown (the dynamically loaded plugin tool)
* 1 subagent (the reviewer) with its own loop and context
* 2 invariant violations in recorded traces (from the adversarial fixture trace)

## 1. Find who decides (Decision boundary, B)

Violet nodes are **model discretion**; grey are deterministic code; amber human; teal
external; red dashed unknown. In the table, the main model call's output is read by the
`stop_reason` branch, the `block.type` filter and the **handler-map dispatch** — i.e. the
model chooses *which tool* runs. The *Requested → authorized → executed* table shows the
code checks in front of that dispatch: the turn and time budgets, `decision.kind === "deny"`
(from `authorize()`), and the unknown-tool check.

## 2. Check what is enforced (Effects & authority, C)

The prompt rule table answers "rule or only instruction?":

| Rule | Status | What it means |
|---|---|---|
| Never delete files outside the workspace | possibly enforced (inferred) | `assertInsideWorkspace` throws for paths outside the workspace — verify by opening the source |
| Never run `git push --force` | related check | `authorize()` asks a human for `git push`, but nothing blocks `--force` |
| Do not read secrets from `.env` files | **prompt-only** | no code prevents `read_file(".env")` |

Select the main model call: every effect it can reach is highlighted, with the gates on the
path. `fs.promises.rm` is reachable through the deny check, the unknown-tool check and the
workspace assertion; human approval sits on a *conditional* path (only when `authorize()`
returns `ask`), which is why it is not listed as a gate "on every route". Open the effect's
detail to see each **call route** with its gates: the reviewer subagent reaches
`readFileTool` without passing `authorize()` at all.

## 3. Check what the model sees (State & memory, D)

The matrix shows the main call receives `prompts/system.md`, the durable memory file
(`.agent/memory.md`) and the conversation (which may be replaced by a model-written summary
in `compactHistory()`); the reviewer gets only `prompts/reviewer.md` and its own
conversation. Uncertain links are flagged instead of guessed.

## 4. Look at real runs (Execution trace, E)

Pick *Publish branch (v1: force push executes)*. Step through: the model requests
`run_shell`, the human approves, the shell allowlist **passes** (`git` is allowed), and the
command executes. Replay is of recorded events only — nothing is executed.

## 5. Make the change

Decide where enforcement belongs. The trace showed the prompt rule alone is insufficient and
the human approval is not specific to `--force`. So enforce it in code, next to the existing
allowlist, and add a guard to `read_file`. In this repository that change is
`fixtures/harnesses/coding-agent-v2` (diff it against `coding-agent`):

* `src/tools/shell.ts`: `isAllowedCommand` rejects `git push --force|-f`
* `src/tools/fs.ts`: `readFileTool` throws on `.env*`
* `src/config.ts`: `MAX_TURNS` 40 → 25
* `prompts/system.md`: one new rule

Before editing, use **Change impact (F)** on the code location you are about to touch
(e.g. `src/tools/shell.ts:9`) or on the prompt (`prompts/system.md`). The result lists
*potentially* affected decisions, model calls and effects — reachability, not prediction —
split into **direct** (same iteration/call) and **indirect** (only through a later turn or
persisted state). For the prompt, every tool effect is direct (the prompt shapes the model's
tool choice in the same turn). For the shell guard, only the shell authorization and the
shell effect are direct; everything else is indirect, because the changed tool result is
appended to the conversation and can influence any later turn.

## 6. Verify statically

Re-run the analysis (`npm run build:data` or `harness-viz analyze`). Open `coding-agent-v2`
→ Change impact → *IR diff vs coding-agent*:

* added `authorization:src/tools/fs.ts#readFileTool/0` (the `.env` guard) and a new branch in
  `isAllowedCommand`
* `guard: turn > MAX_TURNS` constants `{MAX_TURNS: 40}` → `{MAX_TURNS: 25}`
* rule "Do not read secrets from `.env` files": `prompt-only` → `possibly-enforced`
* `fs.promises.readFile` gained a gate

Run the tests (`npm test`) — the IR is deterministic, so unrelated node ids do not move.

## 7. Verify at runtime

Record a trace of the same scenario with the opt-in tracer (`src/instrument/tracer.ts`), or
use the fixture `coding-agent-v2/traces/01-force-push-blocked.jsonl`. In the trace view the
shell authorization now reports `denied`; the reconciliation panel shows 100% of events
mapped, no unexplained successions and no invariant violations. The *Observed behavior
before / after* table compares v1 and v2 traces (terminations, tool requests, denials).
Treat it as evidence from a small sample of nondeterministic runs, not proof.

## 8. Keep an eye on what is unknown (G)

The coverage view lists unresolved items and gaps (here: the plugin tool loads code at
runtime; nothing about it can be verified statically). If your change touches such parts,
static verification is insufficient — rely on runtime evidence and code review.

## Command-line equivalents

```bash
npx tsx src/cli.ts analyze fixtures/harnesses/coding-agent --out /tmp/v1.json
```

```bash
npx tsx src/cli.ts analyze fixtures/harnesses/coding-agent-v2 --out /tmp/v2.json
```

```bash
npx tsx src/cli.ts diff /tmp/v1.json /tmp/v2.json --json
```

```bash
npx tsx src/cli.ts impact /tmp/v1.json src/tools/shell.ts:9
```

```bash
npx tsx src/cli.ts reconcile /tmp/v2.json fixtures/harnesses/coding-agent-v2/traces/*.jsonl
```
