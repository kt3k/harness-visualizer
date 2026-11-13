# Evaluation

All numbers below are **computed** by scripts in this repository on the **synthetic**
fixtures and are reproducible:

```bash
npm run eval
```

```bash
npm run build && npx vite preview --port 4173
```

```bash
npm run e2e
```

Raw results: [`evaluation-results.json`](evaluation-results.json) (analyzer) and
[`evaluation-ui.json`](evaluation-ui.json) (UI walkthrough).

> **Caveat.** The fixtures and their ground-truth labels were written by the same author
> who wrote the analyzer. Labels were made by reading the fixture source (they deliberately
> include cases the analyzer is expected to get wrong), but the sample is small and shares
> the author's coding style. These figures show the tool works as designed on these inputs;
> they are **not** evidence of accuracy on real, unseen harnesses.

## 1. Extraction precision / recall against hand labels

Ground truth: `fixtures/harnesses/*/expected.json`. A predicted node matches a label when
kind, file and line (±1) agree.

| Kind | Precision | Recall | TP | FP | FN |
|---|---|---|---|---|---|
| model call | 1.00 | 1.00 | 10 | 0 | 0 |
| effect | 1.00 | 1.00 | 11 | 0 | 0 |
| state access (durable / db) | 1.00 | 1.00 | 10 | 0 | 0 |
| code check (guard / authorization) | 1.00 | 0.89 | 17 | 0 | 2 |
| model-decided branch / dispatch | 0.93 | 1.00 | 14 | 1 | 0 |
| human input | 1.00 | 1.00 | 2 | 0 | 0 |
| unknown behavior | 1.00 | 1.00 | 2 | 0 | 0 |

The three errors, all understood:

* `coding-agent/src/agent.ts:67` — `if (final === null)` validates model output and leads
  to a retry. Labelled a *check*; the analyzer classifies it as a model-determined branch
  (the following `formatRetries > MAX` guard is found). Counted once as a missed check and
  once as an extra model branch.
* `support-refund-agent/src/refund-agent.ts:41` — the refund threshold diverts to an approval
  queue instead of rejecting, so the analyzer models it as a code *decision* (it still appears
  as a `gates` source for the refund effect and is matched to the prompt rule as a threshold
  mismatch).

**Prompt-rule classification** (enforced / partial / not-enforced / mismatch): **17/19**.
Misses: "Ask the user before deleting any file" (truth: enforced by `authorize()` + approval;
analyzer: *related check*, because the approval is not a rejecting guard), and "You can only
read files" (truth: enforced by capability — the reviewer is only offered `read_file`;
analyzer: *prompt-only*, it does not reason about the tool set).
In v2 the analyzer additionally matches that reviewer rule to the new `.env` guard — a
false positive of the keyword heuristic, labelled `inferred` in the UI.

## 2. Source-link, trace-mapping and unresolved coverage

| Harness | Nodes / edges | Nodes with source link | Edges with evidence | Trace events mapped | Unresolved | Unknown nodes | Nodes with inferred claims | Analysis time |
|---|---|---|---|---|---|---|---|---|
| simple-tool-loop | 30 / 34 | 100% | 100% | 61/61 | 0 | 0 | 0 | ~0.2 s |
| coding-agent | 107 / 189 | 100% | 100% | 174/177 ¹ | 2 | 2 | 15 | ~0.6 s |
| support-refund-agent | 61 / 83 | 100% | 100% | 72/72 | 0 | 0 | 4 | ~0.2 s |
| research-orchestrator | 40 / 58 | 100% | 100% | 51/51 | 0 | 0 | 5 | ~0.3 s |

¹ The three unmapped events are deliberate (adversarial trace): a hallucinated tool
`git_push`, a stale node id, and a termination without location. Two further malformed lines
are reported as parse errors. Times are wall-clock on the CI-class container, single run.

Reconciliation on the regular fixture traces explains **every** observed succession with a
static path (0 unexplained); the adversarial trace's two injected invariant violations
(execution after denial, reviewer loop past its bound) are detected; unobserved branches are
listed as "not observed ≠ unreachable".

## 3. Operator questions: interactions needed in the UI

`scripts/e2e.mjs` drives the built site with Playwright, answers each question on the
coding-agent fixture and asserts the answer is on screen. Counts include opening the harness
from the home page. They are for a scripted user who knows where to click — a lower bound,
**not** a human timing study (none was run).

| Question | View | UI interactions (before → after the plain-language view) |
|---|---|---|
| 1. Where does the LLM choose the next action? | S | 2 → 1 |
| 2. Which rules are enforced by code, which only in the prompt? | S | 2 → 1 |
| 3. Can this model decision lead to a destructive effect, and through which guards? | S | 4 → 1 |
| 4. Which memory is visible to a particular model call? | S | 2 → 1 |
| 5. Why did this observed run terminate or retry? | E | 5 → 5 |
| 6. If a prompt changes, which decisions and effects may be affected? | F | 3 → 3 |
| 7. Which parts remain unknown or insufficiently analyzed? | S | 2 → 1 |

The same script smoke-tests all 8 views of all 5 harnesses (40/40 without runtime errors).

## 4. What was not measured

* Human comprehension or time-to-answer with real operators.
* Accuracy on real (non-synthetic) harnesses, other SDKs or other languages.
* Scalability beyond ~110 nodes per harness (layout of much larger graphs relies on
  collapse/expand and has not been benchmarked).
