# Agent Harness Visualizer — Research & Implementation Instructions

## Role

You are a senior software architect, programming-language researcher, and full-stack engineer. Your task is to investigate, design, implement, and validate a tool that helps humans understand and control complex LLM agent harnesses without reading every line of their source code and prompts.

**Do not stop at a design document. Deliver a working tool, tests, examples, and concise documentation.** Work against the repository supplied by the operator. Do not assume its language, framework, architecture, or trust boundaries before inspecting it.

## Problem and objective

An operator runs multiple large, interdependent agent loops, many of which were written or modified by AI. The operator can ask AI to change behavior but lacks a reliable mental model of what the harness does, why it does it, and which changes affect which behaviors.

Build a visual and inspectable representation that makes these distinctions explicit:

1. **Deterministic control:** code-defined transitions, branching, retries, scheduling, validation, limits, and termination.
2. **Model discretion:** decisions delegated to an LLM, including the options offered, context supplied, output schema, and downstream interpretation.
3. **Authority and effects:** what a model may request versus what the harness can actually execute, including guards, permissions, external effects, and irreversible operations.
4. **State and memory:** what is read, written, persisted, summarized, or omitted from model context.
5. **Runtime evidence:** what actually happened in observed executions, as distinct from what static code appears to permit.
6. **Human control:** where to change a behavior, what might be affected, and how to validate the change.

The goal is **explainable operational control**, not prediction of every token or a claim to know a model's hidden reasoning.

## Non-negotiable principles

- Never present an AI-inferred behavior as a verified fact without evidence.
- Distinguish **enforced**, **advisory**, **observed**, **inferred**, and **unknown** properties. These are separate evidence/assurance dimensions, not necessarily mutually exclusive labels.
- Every extracted claim should link to its source: file, symbol, line span, prompt reference, configuration key, or trace event when available.
- Treat LLM calls as potentially nondeterministic decisions with explicit inputs, outputs, and possible downstream effects.
- Separate **requested tool action**, **authorization/validation**, **actual execution**, and **observed result**.
- Support nested loops, recursion, subagents, asynchronous work, interrupts, retries, and human approval gates. Represent unsupported patterns explicitly rather than silently flattening them.
- Do not execute untrusted harness code, tool calls, or model-generated commands merely to analyze them. Static analysis must be read-only; runtime instrumentation must be opt-in.
- Redact secrets, credentials, personal data, and sensitive prompt/context content from exported graphs and traces by default.
- Prefer a minimal, auditable implementation over a sophisticated but opaque AI-generated summary.

## Phase 1 — Investigate representations before choosing one

Research and compare at least these candidates:

- Hierarchical state machines / statecharts (including SCXML-style concepts).
- Control-flow graphs, call graphs, and interprocedural program analysis.
- Data-flow and provenance graphs.
- Petri nets or workflow nets for concurrent/asynchronous agents.
- Capability and effect systems for permissions and side effects.
- Design-by-contract, transition systems, and lightweight formal specifications.
- Event-sourced execution traces and distributed tracing (e.g. OpenTelemetry concepts).

Evaluate each against: nested agent loops, model-delegated branching, concurrency, state/memory visibility, authorization boundaries, change impact analysis, source traceability, runtime reconciliation, scalability, and human readability.

Create `docs/representation-evaluation.md` with a comparison matrix, tradeoffs, concrete examples, and a justified recommendation. **Do not assume that a statechart is the answer.** A hybrid representation is acceptable and likely useful, but prove its value with representative cases.

## Phase 2 — Define a typed intermediate representation (Harness IR)

Design a versioned, serializable IR that is independent of any one agent framework. Define a JSON Schema or equivalent runtime-validated schema, plus TypeScript types if applicable.

At minimum, represent:

- `Harness`, `Agent`, `Loop`, `State`, `Transition`, `Decision`, `ModelCall`, `ToolRequest`, `Guard`, `Authorization`, `Effect`, `MemoryRead`, `MemoryWrite`, `Prompt`, `HumanApproval`, `Termination`, and `ExternalEvent`.
- Node and edge IDs, containment/hierarchy, source references, and stable identity across repeated analyses.
- Model-call context assembly: prompt layers, memory retrieval, tool definitions, truncation/summarization, structured outputs, and output validation.
- Choice points, possible transitions, preconditions, postconditions, invariants, retries, budgets, timeouts, and failure paths.
- Requested capabilities versus enforceable capabilities; read/write/network/process/financial or other domain-specific effect categories as appropriate.
- Evidence provenance and assurance: static proof, code inspection, runtime observation, model inference, or unknown; include confidence only when meaningful and never confuse confidence with proof.
- Unknown or dynamically resolved behavior, with explicit coverage gaps.
- References from runtime trace events to IR nodes.

Specify semantic rules: which edges mean control flow, data flow, authorization, causation hypothesis, or observed temporal succession. **Do not call an edge causal merely because two events are adjacent.**

Provide at least two example IR files: a simple tool-use loop and a complex nested/subagent loop with retries and approval.

## Phase 3 — Extract a real harness into the IR

Inspect the repository and identify entry points, orchestration loops, LLM invocation sites, prompts, tool registration/execution, state stores, and termination logic.

Implement a repository analyzer that:

1. Locates candidate harness components using language-aware parsing where practical.
2. Extracts verifiable structure statically, preserving source locations.
3. Uses optional LLM-assisted interpretation only for ambiguous semantics; labels such results `inferred` and links supporting evidence.
4. Marks unresolved dynamic dispatch, reflection, generated code, external services, and hidden framework behavior as `unknown`.
5. Produces a coverage report: analyzed files, discovered call sites, unresolved paths, and unlinked nodes.
6. Supports incremental re-analysis and deterministic output for unchanged inputs as far as feasible.

Start with one language/framework actually present in the repository. Build extensible adapters instead of pretending to support every ecosystem.

If no target harness repository is provided, create a small realistic fixture repository and demonstrate the complete workflow on it. Clearly label fixtures as synthetic.

## Phase 4 — Implement an interactive visualizer

Deliver a working local web application or equivalent accessible UI. Select the stack based on the repository, with a short rationale.

### Required views

**A. Architecture overview**
- Show agents, loops, subagents, queues, external systems, and their relationships.
- Expand/collapse nested structures; search, filter, and navigate large graphs.

**B. Decision boundary view**
- Clearly distinguish deterministic code, model discretion, human input, external events, and unknown behavior.
- For each model decision, show what context it receives, which outputs it can produce, and what the harness does with each output.
- Visually separate model-requested operations from validated/authorized/executed operations.

**C. Effects and authority view**
- Show reachable side effects and the enforcement points that gate them.
- Distinguish prompt-only prohibitions from code-enforced restrictions.
- Allow tracing from a model decision to potentially reachable effects, including intermediate guards.

**D. State and memory view**
- Show state stores, reads, writes, persistence boundaries, and which information enters each model call.
- Flag missing or uncertain data-flow links.

**E. Execution trace view**
- Display a timeline of actual events: model call, tool request, authorization, execution, state mutation, error, retry, and termination.
- Link each event to IR nodes and source locations.
- Support replay of recorded events without re-running side effects; distinguish this from live model re-execution.

**F. Change impact view**
- Given a prompt, configuration, or code location, highlight potentially affected decisions, transitions, and effects.
- Label reachability-based impacts as potential, not guaranteed causal consequences.
- Compare IR versions and, where traces exist, compare observed behavior before and after a change.

### Interaction requirements

- Clicking any node reveals: purpose, owner/decision authority, inputs, outputs, guards, effects, source references, evidence type, and uncertainties.
- Provide a direct jump to source code and prompt references where supported.
- Offer a compact high-level map first, with drill-down rather than an unreadable giant graph.
- Provide legends, accessible labels, keyboard navigation where feasible, and layouts that work on large graphs.
- Allow export of the IR and a human-readable summary; exported content must respect redaction settings.

## Phase 5 — Instrumentation and verification

Design an optional trace instrumentation layer with a documented event schema. Include correlation IDs, timestamps, parent/child relationships, node IDs, input/output summaries or hashes, tool request/authorization/execution outcomes, and state-change summaries.

Implement a safe demonstration using fixture traces. If instrumenting a real harness is feasible, make it explicitly opt-in and avoid changing operational semantics.

Validate the IR against execution traces:

- Identify transitions observed at runtime that are absent from the static graph.
- Identify static branches that remain unobserved; do **not** call them unreachable solely because they were not observed.
- Detect violations of enforceable invariants where enough evidence exists.
- Report mismatches and coverage gaps with source and trace references.
- Include regression fixtures for retries, exceptions, cancellation, malformed model outputs, permission denial, and subagent execution.

## Phase 6 — Evaluation and usability

Create representative scenarios and demonstrate that an operator can answer:

1. Where does the LLM choose the next action?
2. Which rules are enforced by code, and which are only instructions in a prompt?
3. Can this model decision lead to a destructive effect, and through which guards?
4. Which memory is visible to a particular model call?
5. Why did this observed run terminate or retry?
6. If a prompt changes, which decisions and downstream effects may be affected?
7. Which parts of the harness remain unknown or insufficiently analyzed?

Measure at least: node/edge source-link coverage, extraction precision on hand-labeled fixtures, trace-to-IR mapping coverage, unresolved dynamic behavior, and time/steps required to answer the scenarios. Document limitations rather than fabricating metrics.

## Deliverables

- `docs/representation-evaluation.md`: researched comparison and selected representation.
- `docs/architecture.md`: architecture, threat model, semantic distinctions, and limitations.
- `docs/ir-spec.md`: versioned IR schema and edge semantics.
- Machine-readable IR schema and sample IR fixtures.
- Working analyzer for at least one real or synthetic harness.
- Working interactive visualizer with the required views.
- Sample traces, trace schema, and static/runtime reconciliation.
- Automated tests, including adversarial and edge-case fixtures.
- `README.md` with setup, run, analyze, inspect, and export instructions.
- `docs/operator-guide.md` explaining how to use the visualization to make a controlled change and verify it.

## Execution protocol

1. Inspect the repository and report a concise inventory of the existing harness architecture.
2. Research representation options and write the evaluation before committing to the IR design.
3. Propose a minimal architecture and implement a vertical slice: source → IR → graph → node detail → trace.
4. Expand to nested loops, effect boundaries, memory, and change impact.
5. Run tests and inspect the actual UI. Fix broken interactions, misleading labels, and unusable layouts.
6. Document what is verified, inferred, and still unknown.
7. Finish with a runnable demonstration, test results, key architectural decisions, and remaining limitations.

Work autonomously within the authorized repository. Do not modify production harness behavior or connect to live external systems without explicit permission. If a design choice is ambiguous, choose a reversible default and record the tradeoff. Ask for clarification only when a missing input prevents safe or meaningful progress.

## Acceptance criteria

The project is complete only when a user can open the visualizer, select a decision node, determine what the model controls versus what the harness enforces, trace possible effects and relevant state/memory, inspect the supporting source code, and compare the specification with at least one actual or fixture execution trace. Every major claim must carry evidence or an explicit uncertainty label. A document or static diagram alone is not sufficient.
