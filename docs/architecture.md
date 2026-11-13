# Architecture

```
 fixtures/harnesses/<h>/      src/analyzer/            src/core/ (browser-safe)          web/ (React + ELK)
 ┌─────────────┐  parse   ┌──────────────────┐  IR  ┌───────────────────────────┐    ┌──────────────────────┐
 │ TS sources  │────────▶│ ProgramIndex     │────▶│ ir.ts  graph.ts  reach.ts │───▶│ 7 views, detail,     │
 │ prompts/*.md│ (read-  │ catalog + taint  │      │ impact.ts  diff.ts        │    │ source viewer,       │
 │ harness.json│  only)  │ projected CFG    │      │ reconcile.ts  trace.ts    │    │ replay, export       │
 └─────────────┘          │ context/gating   │      │ redact.ts  summary.ts     │    └──────────────────────┘
 traces/*.jsonl ─────────────────────────────────────▶ (mapped + reconciled)
                     src/instrument/tracer.ts (opt-in, emits trace v1)
```

* **Analyzer** (`src/analyzer/`, Node): TypeScript compiler API (`typescript@5`), read-only.
  `program.ts` builds a function index and resolves callees through imports, aliases,
  object literals, class members and `promisify`. `catalog.ts` is the only place that
  decides what counts as a model call, effect, state access or human input. `analyze.ts`
  runs: classify calls → durable/db stores → model-call wrappers → relevance → tool
  definitions & handlers → agents → taint (model / human / external origin, inter-procedural
  through parameters and returns, field-sensitive for object-literal returns) → projected CFG
  per function (Walker) → context assembly → store edges → entries/webhooks → gating
  (dominators per function + call routes + "assert" procedures) → subagents/recursion →
  container ports → prompt rules → coverage. `cache.ts` gives incremental re-analysis keyed
  by an inputs hash that includes the analyzer's own source fingerprint.
* **Core** (`src/core/`, no Node imports): IR types, index, reachability, impact, diff,
  reconciliation, redaction, Markdown summary. Shared by CLI, tests and UI so the browser
  computes exactly what the CLI computes.
* **CLI** (`src/cli.ts`): `analyze | reconcile | impact | diff | summary | validate`.
* **Site build** (`scripts/build-site-data.ts`): analyses every harness, validates the IR,
  reconciles traces, writes redacted sources, summaries, diffs → `web/public/data/`.
* **Visualizer** (`web/`): React 18 + elkjs (layered layout with hierarchical compound
  nodes). Static, hash-routed, deployable to GitHub Pages.

### Stack rationale

The target ecosystem for the first adapter is TypeScript (the language of many current
agent harnesses and SDKs, and the language of this repository), so the analyzer uses the
real TypeScript compiler rather than regexes. React + ELK were chosen because ELK is the
only mature browser layout engine with proper *compound* (nested) graph support, which the
containment hierarchy needs; everything else is plain SVG for auditability. No server: the
UI is a static bundle over JSON produced by the CLI.

## Semantic distinctions (how they are computed)

| Distinction | Mechanism | Assurance |
|---|---|---|
| Deterministic control vs model discretion | taint from model-call results; *selection* (equality / case / truthiness on model-derived values) ⇒ `authority: model`; thresholds/predicates in code ⇒ `authority: code` | static (taint), with documented over-approximation |
| Requested vs authorized vs executed | `ToolRequest` (model-selected dispatch) → dominating `Guard`/`Authorization`/approval → `Effect`; traces add *observed* execution and result | static + runtime |
| Enforced vs advisory | code checks = `enforced`; prompt text = `advisory`; prompt rule ↔ guard correspondence = `inferred` (keyword overlap, with the matched terms as evidence) | static / inferred |
| State and memory | messages-slot variables, fs paths shared by read & write, SQL tables; context resolver follows constants, params (callers), returns, transforms | static; unresolved layers flagged |
| Runtime evidence | trace mapping + static path explanation; never called causal | runtime |
| Unknown | dynamic import, `eval`, unresolvable computed dispatch, uncatalogued packages | unknown, listed in coverage |

## Threat model

Assets: the operator's harness source, prompts, traces (may contain user data, secrets),
and the trust the operator places in the tool's claims.

| Threat | Mitigation |
|---|---|
| Executing untrusted harness code or model-generated commands during analysis | Static analysis only: files are parsed by the TypeScript compiler, never imported or run. Prompt files are *read*, not executed. Trace replay re-renders recorded events; it never calls tools or models. |
| Secrets / PII leaking into exported graphs, published sites or traces | `redact.ts` masks API keys, tokens, JWTs, private keys, `*KEY/SECRET/TOKEN/PASSWORD = "…"` assignments, e-mail addresses and phone numbers in prompt text, snippets, copied sources, trace attributes (on load) and every export. `strict` level additionally withholds prompt bodies and trace summaries. The tracer stores only hashes and redacted ≤80-char summaries. Regex redaction is best-effort — review before publishing real harnesses. |
| Over-trusting inferred claims (false sense of safety) | Every claim has an evidence basis; heuristics are labelled `inferred`; "prompt-only" means *no matching guard found*, and "possibly enforced" means *keyword overlap*. Impact results are labelled *potential*. Unobserved ≠ unreachable is stated wherever unobserved branches appear. |
| Under-reporting (missing an effect) | Uncatalogued external calls become `Unknown` nodes, never silently dropped; gaps are listed in coverage. The catalog is explicit and auditable. |
| Malicious trace files | Traces are parsed as data, validated line by line; malformed lines are reported, never evaluated. |
| Instrumentation changing behavior | The tracer only records; it does not wrap or alter control flow. Instrumentation is opt-in. |
| Supply chain of the tool | Small dependency set (typescript, ajv; react, elkjs, vite for the UI), pinned via lockfile. |

## Limitations (known, by design or not yet addressed)

* **One adapter**: TypeScript/JavaScript. Python harnesses are not supported yet.
* **Catalog-bounded**: model/effect/state recognition depends on `catalog.ts` (Anthropic,
  OpenAI, fs, child_process, fetch, Stripe, nodemailer, pg, readline). Other SDKs need
  entries; until then their calls are `Unknown`.
* **Context-insensitive call graph**: a procedure called from two places merges paths;
  reachability and impact over-approximate. Gating is computed per call route to mitigate.
* **Projection**: branches without interesting operations or exits are merged away.
* **Taint is flow-insensitive within a function** and only field-sensitive for functions
  that return object literals; this can over-attribute model influence.
* **Model-call wrappers** are recognised one level deep; context crosses one call level via
  parameters (callers are enumerated).
* **Exceptions**: try/catch is modelled within a function; cross-function exception flow is
  approximated by `throws` edges from call sites inside `try`.
* **Prompt-rule matching is heuristic**: keyword overlap with a small synonym table. It misses
  capability restrictions (e.g. "you can only read files" enforced by offering only a read
  tool) and can match unrelated guards. Always verify.
* **Module initialisation code** is used for value resolution, not modelled as control flow.
* **Live re-execution** of models is out of scope; only recorded replay is supported.
* **Fixtures are synthetic**: metrics in `docs/evaluation.md` come from fixtures written by
  the same author who labelled them.
