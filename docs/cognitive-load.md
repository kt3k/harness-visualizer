# Reducing cognitive load: what changed and why

Feedback on the first version: *"it just dumps the implementation; I can't tell what the
harness actually does."* That was accurate. Every view was a projection of the code (loop-head
junctions, `append to messages`, `!resolved.startsWith(WORKSPACE + path.sep)`), so a reader
had to mentally decompile the graph before learning anything.

## Diagnosis

| Problem | Effect on the reader |
|---|---|
| Labels were code expressions and API names | must read code to read the diagram |
| Landing view was a dense graph | no entry point; "where do I start?" |
| Implementation detail had the same weight as behavior (loop heads, return points, conversation appends, reply-part filters) | signal drowned in noise |
| Answers were scattered across 7 views | many hops for basic questions |
| Risks were buried in tables | the most important facts were not first |

## Changes implemented

1. **A "What it does" page is now the landing view** (`web/src/views/StoryView.tsx`,
   `src/core/story.ts`). It is ordered by what a person asks first:
   * **Watch out**: risks first (ungated irreversible effects, prompt/code threshold
     mismatches, prompt-only rules, code that cannot be analysed, partly enforced rules).
   * **One section per agent / entry point**: what starts it, the model's job (first sentence
     of its system prompt), **step by step** in plain language (loops, model calls with
     what the model sees and may choose, checks with their outcome, branches with where
     they lead, human approvals), and **how it ends** with the reason for each ending.
   * **What the model can do**: one row per tool: what it really does (side effects,
     subagents, unknown code), what can stop it in code, what the prompt says (marked
     *not enforced* where applicable), plus the checks applied before any tool runs.
   * **What it touches**: external systems grouped (files, shell, web hosts, Stripe, e-mail,
     database tables, memory file, LLM APIs, humans).
2. **A plain-language layer** (`src/core/humanize.ts`), deterministic and generic. Phrases
   are assembled only from text the harness authors wrote (error messages, identifiers,
   tool descriptions, prompts), resolved constants (`MAX_TURNS = 40` → "more than 40 turns
   used", `RUN_TIMEOUT_MS` → "15 min", `*_CENTS` → dollars), well-known SDK semantics
   (`stop_reason === "tool_use"` → "the model asks to use a tool") and a small boolean
   expression paraphraser (`mode === "read-only" && MUTATING_TOOLS.has(toolName)` → "mode is
   “read-only” and tool name is in mutating tools"). Anything it cannot paraphrase is shown
   as code in monospace, so a paraphrase is never presented as more than it is. No LLM is
   involved.
3. **Every line is traceable**: each story line carries the IR node ids it came from; clicking
   it opens the evidence/source panel. A test checks that every id exists.
4. **Graphs show plain labels and hide details by default**: two toolbar toggles (*plain
   labels*, *hide details*). Hidden detail nodes are *contracted*: edges are drawn across
   them, so flow is preserved. The large-graph view now opens centred on the main model
   call instead of the entry point.
5. **Plain labels everywhere**: links in tables and the detail panel use the phrase; the code
   label moves to a secondary "code:" line and the tooltip.
6. **Export** (Markdown) starts with the plain-language story; the technical inventory follows.

## Measured effect

Interactions needed to answer the seven operator questions in the UI (Playwright walkthrough,
scripted user, includes opening the harness): questions 1–4 and 7 went from 2–4 interactions
to **1** each (the answer is on the landing page); 5 and 6 are unchanged (5 and 3). This is a
lower bound for a user who knows where to look, not a human study.

## Further proposals (not yet implemented)

* **Behavior-level state diagram** per agent (Start → Ask model → {use tool → checks → run
  tool → back | answer → validate → finish}) rendered from the same story model, as a
  compact picture alongside the outline.
* **Question-driven entry** ("Can it spend money?", "Can it delete files?", "What does it
  send to the model?"): one click to a filtered answer with evidence.
* **Diff in plain language**: "v2 now refuses `git push --force`; turn limit 40 → 25;
  `.env` rule is now enforced", generated from the IR diff with the same phrasing layer.
* **Optional LLM-written summaries**, clearly labelled `inferred`, with the deterministic
  story kept as the reference.
* **Per-trace narrative** ("the model read 2 files, a human rejected a delete, the run ended
  because …") for the execution trace view.

## Second iteration: show nothing that was not asked for

Policy: by default the UI shows **only answers**. Everything else is revealed by an explicit
action. There are three levels:

| Level | Shown when | Content |
|---|---|---|
| L0 answer | always | what the harness does, in plain language (one-sentence summary, steps, tools, what it touches, warnings) |
| L1 details | the user clicks a line or a node | an explanation of that item: who decides, what happens next, what can stop it, what it may lead to |
| L2 evidence | the user presses **why?** on a line, opens **Evidence** in the details, or turns on **Evidence: on** in the header | source location and code, how sure the tool is (static / inferred / runtime / unknown), the reasoning, recorded-run observations, raw attributes |

What moved out of the default view: the generation disclaimer, the synthetic-fixture banner,
statistics, evidence chips, file paths, function signatures, model ids, constant names,
"verify" notes, code tooltips, observation badges outside the trace view, node counts, keyboard
hints, the evidence legend in the empty details panel, the always-visible details panel itself,
the below-graph tables (collapsed), and the trace/spec comparison (collapsed).

Uncertain claims (option A): the default text never states a heuristic result as fact; the
*wording* carries the uncertainty ("seems to use a different limit", "may need a human's OK",
"likely retries on failure", "no code check for it was found"), and the reason is at L2.

Regression guard: `scripts/e2e.mjs` checks 24 default screens (4 harnesses × 6 views) for
visible chips, observation badges, an open details panel, and evidence vocabulary (file paths,
`static`/`inferred`/`runtime`, model ids, constant names). It also checks that "why?" does
reveal the source location on request. `tests/story.test.ts` checks the generated text itself.
