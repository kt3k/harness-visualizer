/**
 * Harness IR — a framework-independent, versioned representation of an LLM
 * agent harness. See docs/ir-spec.md for semantics. This module is
 * browser-safe (no Node imports) and is shared by the analyzer, the CLI and
 * the visualizer.
 */

export const IR_VERSION = "0.1.0";

export type NodeKind =
  | "Harness"
  | "Agent"
  | "Loop"
  | "Junction"
  | "Procedure"
  | "ToolSet"
  | "Tool"
  | "State"
  | "Decision"
  | "ModelCall"
  | "ToolRequest"
  | "Guard"
  | "Authorization"
  | "HumanApproval"
  | "Effect"
  | "MemoryRead"
  | "MemoryWrite"
  | "Prompt"
  | "PromptRule"
  | "Termination"
  | "ExternalEvent"
  | "Unknown";

export const CONTAINER_KINDS: ReadonlySet<NodeKind> = new Set<NodeKind>([
  "Harness",
  "Agent",
  "Loop",
  "Procedure",
  "ToolSet",
  "Tool",
  "Prompt",
]);

/** Who decides what happens at this node. */
export type Authority = "code" | "model" | "human" | "external" | "unknown";

/**
 * How a claim is supported.
 *  - static:   derived from AST / symbol resolution of the analysed source
 *  - inferred: derived from a heuristic (names, keywords) or an LLM; never proof
 *  - runtime:  observed in an execution trace
 *  - unknown:  the analyzer could not determine it
 */
export type EvidenceBasis = "static" | "inferred" | "runtime" | "unknown";

/** Whether a constraint is enforced by code or is only advice to the model. */
export type Enforcement = "enforced" | "advisory" | "none" | "unknown";

export interface SourceRef {
  file: string;
  startLine: number;
  endLine: number;
  /** enclosing symbol path, e.g. "runAgent" or "TOOLS[write_file].run" */
  symbol?: string;
  role?: "code" | "prompt" | "config" | "trace";
  /** short excerpt, already redacted */
  snippet?: string;
}

export interface Evidence {
  basis: EvidenceBasis;
  /** e.g. "ast:call-pattern", "checker:symbol", "heuristic:keyword-overlap" */
  method: string;
  claim: string;
  ref?: SourceRef;
  /** Only for heuristic/LLM claims; never a substitute for proof. */
  confidence?: number;
}

export interface Assurance {
  /** Weakest basis among the claims needed for this node to exist as typed. */
  basis: EvidenceBasis;
  enforcement?: Enforcement;
}

export interface IRNode {
  id: string;
  kind: NodeKind;
  label: string;
  parent?: string;
  summary?: string;
  authority?: Authority;
  sourceRefs: SourceRef[];
  evidence: Evidence[];
  assurance: Assurance;
  uncertainties: string[];
  attrs: Record<string, unknown>;
}

export type EdgeKind =
  | "transition" // static possible control succession (CFG projection)
  | "invokes" // call into a procedure / agent / handler
  | "dispatches" // model-selected tool dispatch: ToolRequest -> Tool
  | "offers" // tool definition offered in a model call's context
  | "context" // data enters a model call's context
  | "reads" // State -> MemoryRead
  | "writes" // MemoryWrite -> State
  | "interprets" // model output consumed by a decision / dispatch
  | "gates" // enforcement point -> gated effect / request
  | "corresponds" // inferred correspondence PromptRule <-> guard / tool
  | "resumes" // ExternalEvent resumes a procedure
  | "causal-hypothesis"; // inferred causal claim (never from adjacency)

export type EdgeSemantics =
  | "control"
  | "invocation"
  | "data"
  | "authorization"
  | "correspondence"
  | "causal-hypothesis";

export const EDGE_SEMANTICS: Record<EdgeKind, EdgeSemantics> = {
  transition: "control",
  invokes: "invocation",
  dispatches: "invocation",
  resumes: "invocation",
  offers: "data",
  context: "data",
  reads: "data",
  writes: "data",
  interprets: "data",
  gates: "authorization",
  corresponds: "correspondence",
  "causal-hypothesis": "causal-hypothesis",
};

export interface IREdge {
  id: string;
  kind: EdgeKind;
  from: string;
  to: string;
  label?: string;
  condition?: string;
  evidence: Evidence[];
  attrs: Record<string, unknown>;
}

export interface CoverageReport {
  filesAnalyzed: { path: string; sha256: string; lines: number }[];
  filesSkipped: { path: string; reason: string }[];
  callSites: {
    total: number;
    byClass: Record<string, number>;
  };
  unresolved: {
    file: string;
    line: number;
    expr: string;
    reason: string;
    nodeId?: string;
  }[];
  unlinkedNodes: string[];
  sourceLinkCoverage: {
    nodesWithSource: number;
    nodes: number;
    edgesWithEvidenceRef: number;
    edges: number;
  };
  gaps: string[];
}

export interface HarnessIR {
  irVersion: string;
  harness: {
    id: string;
    name: string;
    description?: string;
    synthetic: boolean;
    version?: string;
    /** id of the harness this one is a later version of (for diffs) */
    baseline?: string;
    repository?: { url: string; ref: string; pathPrefix: string };
  };
  analysis: {
    analyzer: string;
    analyzerVersion: string;
    adapter: string;
    /** sha256 over analyzer version, config and all input file hashes */
    inputsHash: string;
    redaction: RedactionLevel;
  };
  nodes: IRNode[];
  edges: IREdge[];
  coverage: CoverageReport;
}

export type RedactionLevel = "strict" | "standard";

// ---------------------------------------------------------------------------
// Kind-specific attribute shapes (documentation + light typing for consumers)
// ---------------------------------------------------------------------------

export interface ContextLayer {
  order: number;
  slot: string; // "system" | "messages" | "tools" | "tool_choice" | ...
  kind:
    | "prompt"
    | "conversation"
    | "memory"
    | "tool-definitions"
    | "parameter"
    | "input"
    | "model-output"
    | "literal"
    | "unknown";
  expr: string;
  ref?: string; // node id
  transforms: string[];
  certainty: "resolved" | "partial" | "unresolved";
}

export interface ModelCallAttrs {
  provider: string;
  api: string;
  model?: string;
  context: ContextLayer[];
  toolsOffered: string[];
  toolChoice?: string;
  structuredOutput?: string;
  transport?: SourceRef;
  outputHandling: { nodeId: string; condition: string }[];
}

export interface EffectAttrs {
  category: string;
  irreversible: boolean | "unknown";
  api: string;
  target?: string;
  gatedBy: string[];
}

export function nodeById(ir: HarnessIR): Map<string, IRNode> {
  return new Map(ir.nodes.map((n) => [n.id, n]));
}
