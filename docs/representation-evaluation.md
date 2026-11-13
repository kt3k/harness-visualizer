# Representation evaluation

Status: decision record for Harness IR v0.1. Written before the IR was fixed;
revisited after the analyzer and visualizer were built against four synthetic
harnesses (see "Validation against representative cases").

## 1. What the representation must carry

An operator's questions about an agent harness (see `docs/operator-guide.md`)
reduce to ten requirements. Each candidate below is scored against them.

| # | Requirement | Why it matters for LLM harnesses |
|---|-------------|----------------------------------|
| R1 | Nested loops, subagents, recursion | Agent loops call tools that start other agent loops. |
| R2 | Model-delegated branching | The branch is chosen by `stop_reason`, a tool name, or a parsed field of model output — not by code. |
| R3 | Concurrency / async | `Promise.all` fan-out, approval queues that resume on webhooks, timeouts/aborts. |
| R4 | State and memory visibility | What enters each model call; truncation/summarization; what is persisted. |
| R5 | Authorization boundaries | "The model may request X" ≠ "the harness executes X". |
| R6 | Change impact | "If I change this prompt / guard / constant, what may change?" |
| R7 | Source traceability | Every claim links to file/line, prompt span or trace event. |
| R8 | Runtime reconciliation | Static "may" vs observed "did". |
| R9 | Scalability | Real harnesses have hundreds of call sites. |
| R10 | Human readability | The operator is not reading the code; a giant graph is useless. |

## 2. Candidates

### 2.1 Hierarchical state machines / statecharts (Harel, SCXML)

Concepts: compound and parallel states, transitions with event/guard/action,
history states, `<invoke>` for child machines.

* **Strengths.** Excellent for R1 (compound states nest naturally), good for R10
  (people read statecharts), parallel regions give some R3. Guards on
  transitions are a first-class concept, which maps to code-enforced checks.
* **Weaknesses.** A statechart assumes the *states are designed*. Agent
  harnesses are written as imperative loops; their "states" are program
  points, and forcing them into named states requires invention (an inferred,
  unverifiable artefact). Statecharts have no notion of *who* chooses a
  transition: a guard `stop_reason == "tool_use"` looks identical to
  `turns >= MAX_TURNS`, which erases the single most important distinction
  (R2). No data-flow (R4) or effect semantics (R5).
* **Example.** The coding agent's turn loop becomes
  `AwaitModel → (tool_use) Dispatch → AwaitModel | (end_turn) ValidateFinal → Done`.
  Readable — but the statechart cannot express that `Dispatch` can reach
  `fs.rm` only through `assertInsideWorkspace` and a human-approval gate.

### 2.2 Control-flow graphs, call graphs, interprocedural analysis

* **Strengths.** Mechanically extractable with source locations (R7), sound
  w.r.t. the code that was analysed, handles nesting via call graph (R1).
  Dominance tells us which checks precede an effect (R5 foundation).
* **Weaknesses.** Raw CFGs are unreadable at scale (R9/R10): the 120-line
  coding agent loop has ~400 basic blocks. Dynamic dispatch (`handlers[name]`)
  is exactly where the model chooses, and a plain CFG either drops the edge or
  over-approximates silently.
* **Usable form.** A *projected* CFG over "interesting" program points (model
  calls, decisions, guards, effects, state writes, terminations) keeps
  soundness of order while removing noise.

### 2.3 Data-flow and provenance graphs (W3C PROV-style)

* **Strengths.** The natural answer to R4 ("which memory reaches this call?")
  and to taint-style questions ("is this branch condition derived from model
  output?" — the test that distinguishes R2 branches). PROV's
  entity/activity/agent split mirrors prompt/model-call/operator.
* **Weaknesses.** No control semantics; does not answer "can this lead to an
  effect". Precise interprocedural data flow in JS/TS is expensive; partial
  results must be marked partial.

### 2.4 Petri nets / workflow nets

* **Strengths.** The only candidate with rigorous concurrency semantics (R3):
  fork/join, resource tokens (budgets), soundness checks (no deadlock, proper
  completion). Approval queues are naturally places with tokens.
* **Weaknesses.** Poor readability for non-specialists (R10), awkward for
  recursion (R1) without coloured/nested extensions, and extraction from
  imperative code requires the same projected CFG anyway. Verification value
  only materialises if the net is faithful, which we cannot guarantee for
  model-dependent branches.
* **Kept:** fork/join annotations and "mode: parallel" on invocation edges;
  explicit `ExternalEvent` nodes for resumption points.

### 2.5 Capability and effect systems

* **Strengths.** Directly answer R5: an effect has a category (fs.write,
  process.exec, network, financial, messaging), reversibility, and a set of
  enforcement points. Separating *requested capability* (tool offered to the
  model) from *enforceable capability* (what the code path can actually do)
  is the core of the "authority" view.
* **Weaknesses.** Effect typing is not inferable from JS/TS in general; it has
  to come from a catalog of known APIs, so coverage is bounded by the catalog
  and unknown external calls must be reported as unknown.

### 2.6 Design-by-contract, transition systems, lightweight formal specs

* **Strengths.** Pre/postconditions and invariants give *checkable* claims for
  R8: "every `refunds.create` is preceded by an approval when amount > limit".
  Contracts make the difference between enforced and advisory precise: a
  precondition checked by code is enforced; one stated in a prompt is advice.
* **Weaknesses.** Someone must write them; extracted contracts are only as good
  as the guard detection. Useful as a *layer* (invariants attached to nodes),
  not as the primary structure.

### 2.7 Event-sourced execution traces / distributed tracing (OpenTelemetry)

* **Strengths.** Spans with parent/child IDs represent nested and concurrent
  executions faithfully (R1, R3) and are the only source of *observed* truth
  (R8). Correlation IDs let us map events to static nodes.
* **Weaknesses.** Purely empirical: absence of an event is not evidence of
  impossibility. Adjacency in a trace is temporal succession, not causation.
  No static structure for R6.

## 3. Comparison matrix

Scores: ● strong, ◐ partial, ○ weak/none.

| Requirement | Statechart | Projected CFG + call graph | Data-flow / provenance | Petri / workflow net | Capability / effects | Contracts | Traces (OTel) |
|---|---|---|---|---|---|---|---|
| R1 nesting / subagents | ● | ● | ◐ | ◐ | ○ | ○ | ● |
| R2 model-delegated branching | ○ | ◐ (needs taint) | ● (taint) | ○ | ○ | ○ | ◐ (observed only) |
| R3 concurrency / async | ◐ | ◐ | ○ | ● | ○ | ○ | ● |
| R4 state / memory | ○ | ○ | ● | ◐ | ○ | ◐ | ◐ |
| R5 authority / effects | ◐ (guards) | ◐ (dominance) | ○ | ○ | ● | ● | ◐ |
| R6 change impact | ◐ | ● (reachability) | ● | ◐ | ◐ | ◐ | ○ |
| R7 source traceability | ◐ (if extracted) | ● | ● | ◐ | ◐ | ◐ | ● (to events) |
| R8 runtime reconciliation | ◐ | ● (target of mapping) | ◐ | ◐ | ◐ | ● (checkable) | ● |
| R9 scalability | ◐ | ● (projection) | ◐ | ○ | ● | ● | ● |
| R10 readability | ● | ◐ | ○ | ○ | ● (tables) | ◐ | ◐ (timeline) |
| Extractable from code without invention | ○ | ● | ◐ | ○ | ◐ (catalog) | ◐ | n/a |

No single column is strong across the board. Statecharts win readability but
lose the decisive R2 distinction; CFGs are extractable and traceable but
unreadable raw; traces are the only ground truth but cannot predict.

## 4. Recommendation: a layered hybrid ("Harness IR")

One typed graph with **containment** borrowed from statecharts, a **projected
interprocedural CFG** as the control backbone, and four overlays:

1. **Hierarchy (statechart-style containment).** `Harness ⊃ Agent ⊃ Loop ⊃
   nodes`; `ToolSet ⊃ Tool ⊃ handler nodes`; procedures as siblings. Collapsing
   a container lifts its edges — this is what makes R9/R10 workable.
2. **Control backbone (projected CFG).** Only interesting program points become
   nodes (`ModelCall`, `Decision`, `Guard`, `Authorization`, `HumanApproval`,
   `Effect`, `MemoryRead/Write`, `Termination`, loop-head `Junction`).
   `transition` edges mean *static possible succession*, labelled with the
   branch condition.
3. **Authority overlay (taint + capability).** Every `Decision` carries
   `authority: code | model | human | external | unknown`, decided by whether
   its condition is data-dependent on a model call's output. Tool dispatch is a
   `ToolRequest` node whose `dispatches` edges are model-selected; `gates`
   edges connect enforcement points to the effects they dominate; effects carry
   category and reversibility from a catalog.
4. **Data overlay (provenance).** `context` edges show what enters each model
   call (prompt layers, conversation state with its transforms, memory reads),
   `reads`/`writes` connect `State` stores. Unresolved links are explicit and
   flagged.
5. **Assurance/evidence overlay.** Every node and edge has `evidence[]`
   (basis: static / inferred / runtime / unknown, with method and source) and
   constraints carry `enforcement: enforced | advisory`. Prompt rules are
   `PromptRule` nodes, always advisory; their correspondence to code guards is
   an *inferred* edge with the matched keywords as evidence.
6. **Runtime layer (event-sourced traces).** OTel-like spans/events reference IR
   nodes by id or source location; reconciliation produces
   `observed-succession` relations that are kept separate from static edges
   and never labelled causal.

Petri-net semantics are reduced to what is extractable: `mode: parallel` on
invocation edges and `ExternalEvent` resumption nodes. Contracts appear as
`invariants` attached to effects (e.g. "preceded by gate G") that the
reconciler checks against traces.

## 5. Validation against representative cases

The recommendation was tested on the four synthetic harnesses in
`fixtures/harnesses/` (all labelled synthetic):

| Case | What a statechart alone would show | What the hybrid adds (and the fixture proves) |
|---|---|---|
| `simple-tool-loop` | Two states, two transitions | `stop_reason` branches are `authority: model`; turn budget is `authority: code`; `fetch` effect reachable from the model's tool choice through an input guard. |
| `coding-agent` | Loop + dispatch state | `fs.rm` reachable from the model only via `assertInsideWorkspace` (enforced) and human approval (enforced); "never `git push --force`" exists only in the prompt (advisory, no matching guard) and the shell allowlist admits `git`; memory file content enters every main-loop model call but not the reviewer subagent's. |
| `support-refund-agent` | Router state with 4 outgoing transitions | Router branches are model-chosen via a forced-tool enum; refund threshold in prompt ($100) differs from code ($500) — flagged as an inferred mismatch; `sendMail` is an irreversible effect with no code gate; refund resumes from an `ExternalEvent` (approval webhook). |
| `research-orchestrator` | Parallel region of researchers | Fan-out via `Promise.allSettled` (mode: parallel), recursion bounded by a depth guard, abort/timeout as cancellation guard; trace reconciliation shows a cancelled researcher and an unobserved recursion branch (reported as *unobserved*, not unreachable). |

In each case the decisive operator question (who chose this branch? which gate
stops this effect? what does the model see?) is answerable only with the
overlays; the containment hierarchy is what keeps the picture small enough to
read.

## 6. Tradeoffs accepted

* **Projection loses detail.** Uninteresting branches are merged; a branch that
  matters but contains no interesting node is invisible. Mitigation: any
  branch containing an exit (`return`/`throw`/`break`/`continue`) inside a loop
  is kept.
* **Context-insensitive call graph.** A procedure called from two places is one
  container; paths through it merge. Reachability is therefore an
  over-approximation, which is why impact results are labelled *potential*.
* **Guard detection is structural.** "An `if` whose branch rejects, preceding
  the effect in the same or a calling function" approximates dominance. Name
  heuristics only *label* guards (e.g. as authorization); they never create
  enforcement claims.
* **Catalog-bounded effects.** Effects of unknown libraries are reported as
  `Unknown` external calls, not silently dropped.
* **Statechart naming is not attempted.** We do not invent state names; nodes
  are program points named by their code. This sacrifices some readability for
  never presenting invented structure as fact.
