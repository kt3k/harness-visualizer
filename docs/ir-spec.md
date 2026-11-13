# Harness IR specification (v0.1.0)

Machine-readable schemas: [`schema/harness-ir.schema.json`](../schema/harness-ir.schema.json)
(JSON Schema 2020-12, generated from `src/core/ir.ts` by `scripts/gen-schema.ts`) and
[`schema/trace-event.schema.json`](../schema/trace-event.schema.json). TypeScript types:
[`src/core/ir.ts`](../src/core/ir.ts), [`src/core/trace.ts`](../src/core/trace.ts).
Runtime validation (schema + referential integrity + acyclic containment):
`harness-viz validate <ir.json>` / `src/ir-validate.ts`.

Examples: [`examples/ir/simple-tool-loop.ir.json`](../examples/ir/simple-tool-loop.ir.json)
(simple tool-use loop) and [`examples/ir/coding-agent.ir.json`](../examples/ir/coding-agent.ir.json)
(nested loops, reviewer subagent, retries, human approval, memory, dynamic plugin).
A test asserts both stay in sync with the analyzer.

## 1. Document

```jsonc
{
  "irVersion": "0.1.0",
  "harness":  { "id", "name", "description?", "synthetic", "version?", "baseline?", "repository?" },
  "analysis": { "analyzer", "analyzerVersion", "adapter", "inputsHash", "redaction": "standard|strict" },
  "nodes":    [IRNode],
  "edges":    [IREdge],
  "coverage": CoverageReport
}
```

`inputsHash` = sha256 over analyzer version, a fingerprint of the analyzer's own source,
the harness config, redaction level, and every input file's sha256. Equal hash ⇒ identical
IR (deterministic output; used by the incremental cache).

## 2. Nodes

Common fields: `id`, `kind`, `label`, `parent?` (containment), `summary?`, `authority?`,
`sourceRefs[]`, `evidence[]`, `assurance`, `uncertainties[]`, `attrs`.

### 2.1 Identity

IDs are derived from **kind + file + symbol path + per-function ordinal** — never line
numbers — e.g. `effect:src/tools/fs.ts#deleteFileTool/0`. Editing other functions does not
change an ID; inserting a node of the same kind *earlier in the same function* shifts the
ordinals after it (documented limitation). The root is always `harness`, so different
versions of a harness diff cleanly.

### 2.2 Kinds

| Kind | Meaning | Key attrs |
|---|---|---|
| `Harness` | root container | — |
| `Agent` | function containing a loop that calls a model | `role` (agent/subagent), `recursive`, `invokedBy`, `modelCalls`, `terminations` |
| `Loop` | loop containing interesting operations | `loopType` (agent/retry/iteration/loop), `condition`, `constants` (resolved bounds), `infinite` |
| `Junction` | pseudo control location: loop head, return/throw point, SDK transport | `role` |
| `Procedure` | other function on a path to interesting operations | `role` (procedure/policy/model-transport) |
| `ToolSet` / `Tool` | tool definitions offered to models; a Tool contains its handler's nodes | `name`, `schema`, `handler`, `handlerVia`, `structuredOutput` |
| `State` | a store: conversation (ephemeral), file (durable), db table (external) | `persistence`, `medium`, `locator` |
| `ModelCall` | LLM invocation | `provider`, `api`, `model`, `context[]` (§4), `toolsOffered`, `toolChoice`, `structuredOutput`, `transport`, `outputHandling` |
| `Decision` | branch; `authority` says who decides | `condition`, `constants`, `taintSources`, `validatesModelInput`, `cases` |
| `ToolRequest` | model-selected dispatch to a tool | `selector`, `mechanism` (handler-map/switch/if-chain), `candidates`, `modelSelected`, `gatedBy`, `routes` |
| `Guard` | code check that rejects (throw / error result / exit) | `purpose` (budget/cancellation/validation/input-validation/output-validation), `rejectText`, `rejectExit` |
| `Authorization` | a Guard whose purpose is permission | as Guard |
| `HumanApproval` | blocking human input or indirect approval request | `mode` (blocking/indirect) |
| `Effect` | catalogued side effect | `category`, `irreversible`, `api`, `target`, `args`, `modelControlledArgs`, `gatedBy`, `routes`, `ungatedRoute` |
| `MemoryRead` / `MemoryWrite` | access to a `State` | `store`, `op`, `effectCategory` (writes to durable/external stores are also effects) |
| `Prompt` / `PromptRule` | prompt text; rules extracted from it | rule: `text`, `polarity`, `status`, `matchedGuards`, `mismatches`, `relatedTools` |
| `Termination` | where an agent/entry run ends | `reason`, `kind` (return/error) |
| `ExternalEvent` | entry point or webhook | `trigger` (entry/webhook) |
| `Unknown` | operation whose behavior is not statically visible | `reason` |

`Transition` from the minimum list is represented as an **edge** of kind `transition` (§3);
`State` denotes a *store* — control positions are the nodes themselves plus `Junction`s.

### 2.3 Authority (who decides at this node)

`code` · `model` · `human` · `external` · `unknown`.
A `Decision` has `authority: model` when its condition **selects among fixed options using
model output** (equality against a literal, `switch` case, truthiness of a model-derived
value). A predicate/threshold defined in code applied to model-supplied data is
`authority: code` with `validatesModelInput: true` — the model supplies the value, code
decides. Guards are always enforced by code; their `authority` is `human`/`external` when the
checked value comes from a human answer or an external event.

### 2.4 Evidence and assurance — separate dimensions

* `evidence[]`: each claim has `basis` (`static` | `inferred` | `runtime` | `unknown`),
  `method` (e.g. `catalog:effect-api`, `cfg:dominance`, `dataflow:taint`,
  `heuristic:keyword-overlap`), the `claim`, optional `ref` and optional `confidence`.
  `confidence` appears only on heuristic matches and is a ranking score, **not a probability
  of truth and never proof**.
* `assurance.basis`: weakest basis among the evidence needed for the node to exist as typed.
* `assurance.enforcement`: for constraints — `enforced` (code check), `advisory` (prompt
  text), `none`, `unknown`.
* **observed** is not stored in the static IR; it comes from reconciliation (§6) as an overlay.

So a node can be *static + enforced + observed*, or *static + advisory + not observed*, etc.

## 3. Edges and their semantics

| Edge kind | Semantics | Meaning |
|---|---|---|
| `transition` | control | **static possible succession** in the projected CFG; `label` carries the branch (`if …`, `reject: …`, `pass`, `case …`, `tool = …`, `next iteration` (`attrs.backEdge`), `call`/`return`, `fork`/`join` (`attrs.mode: parallel`), `throws`) |
| `invokes` | invocation | caller container → callee container (call graph); `mode: parallel` for `Promise.all*` fan-out; self-edge = recursion |
| `dispatches` | invocation | `ToolRequest` → `Tool`, **selected by the model** |
| `resumes` | invocation | reserved: external event resumes a procedure |
| `offers` | data | tool definitions placed in a model call's `tools` slot |
| `context` | data | prompt / conversation / memory read / input enters a model call (`slot`, `transforms`, `certainty`) |
| `reads` / `writes` | data | `State` → `MemoryRead`; `MemoryWrite` → `State` |
| `interprets` | data | model call output is read by a decision / dispatch / output validation |
| `gates` | authorization | enforcement point → gated effect/request: the gate **dominates** the target in its function (or on a call route) **and** has a branch that avoids it; `attrs.allRoutes` |
| `corresponds` | correspondence | `PromptRule` → guard/tool, **inferred** from keyword overlap |
| `causal-hypothesis` | causal hypothesis | inferred, with explicit evidence (e.g. shared store between an approval request and a webhook) |

Rules: no edge is called causal because two events are adjacent; temporal succession from
traces is kept **outside** the IR (reconciliation `steps`), and only `causal-hypothesis`
edges — always `inferred` — make causal claims.

## 4. Model-call context assembly

`attrs.context[]` lists layers in request order:
`{ order, slot (system|messages|tools|tool_choice|response_format|spread), kind (prompt|conversation|memory|tool-definitions|input|model-output|parameter|literal|unknown), expr, ref?, transforms[], certainty (resolved|partial|unresolved) }`.
Transforms record how data was shaped on the way: `.slice(0, -6)`, `JSON.stringify`,
`buildSystemPrompt()`, `replaced by compactHistory() — may summarize older turns with
<modelcall id>`, `via parameter … of …()`, `[loop element]`. Anything the resolver cannot
follow (beyond depth 20, computed values, destructuring) is a layer with `certainty:
unresolved` and is listed in `coverage.unresolved`.

## 5. Coverage

`filesAnalyzed` (with sha256), `callSites.byClass` (model / effect / state-read / … /
external-unknown / unresolved / pure), `unresolved[]` (file, line, expr, reason, node),
`unlinkedNodes`, `sourceLinkCoverage`, and textual `gaps` (e.g. context-insensitive call
graph, uncatalogued modules, unlinked prompt files).

## 6. Trace events (v1) and reconciliation

One JSON object per JSONL line (comment lines starting `//` carry trace metadata):

```jsonc
{ "v": 1, "traceId", "spanId", "parentSpanId?", "seq", "ts", "type",
  "nodeId?", "loc?": { "file", "line" }, "name?", "status?",
  "inputHash?", "outputSummary?", "attrs?" }
```

Types: `run.start|end`, `agent.start|end`, `loop.iteration`, `model.request|response`,
`decision`, `tool.request`, `authz.decision`, `approval.request|response`,
`tool.execute|result`, `state.read|write`, `error`, `retry`, `cancel`, `termination`,
`external.event`. Status: `ok|error|denied|approved|rejected|cancelled|pending`.

The opt-in instrumentation (`src/instrument/tracer.ts`) records only hashes and redacted
short summaries of inputs/outputs, with correlation (`traceId`), parent/child spans and a
monotonic `seq`.

**Mapping** (`src/core/reconcile.ts`): by `nodeId`; else by `loc` (smallest source span of
an expected kind); else by tool `name`; unmapped events are reported with a reason.

**Successions**: within a span, consecutive *step* events, plus parent → first event of a
child span. A succession A→B is *explained* if a static control path A ⇝ B exists whose
interior does not contain nodes instrumented in that trace. The explaining path is stored in
`steps[]` (it is evidence of *possibility*, not causation).

**Reports**: `unexplained` (observed, no static path), `unobservedBranches` (with the note
"not observed ≠ unreachable"), `violations` of enforceable invariants
(`denied-request-not-executed`, `loop-bound` against resolved static bounds), `mismatches`
(unmapped events, tools absent from the static graph, malformed lines).

## 7. Versioning

`irVersion` follows semver: additive attrs/kinds = minor; changed semantics of an existing
kind/edge = major. Consumers must ignore unknown `attrs` keys.
