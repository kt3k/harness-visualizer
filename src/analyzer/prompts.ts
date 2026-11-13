/**
 * Prompt rule extraction and (heuristic) correspondence with code guards.
 * Everything produced here about correspondence is `inferred`: keyword
 * overlap is evidence of a *possible* relation, never proof of enforcement.
 */

export interface ExtractedRule {
  text: string;
  lineOffset: number;
  polarity: "prohibition" | "obligation" | "restriction";
}

const RULE_RE = /\b(never|do not|don't|must not|mustn't|cannot|can only|only|always|must|without|ask (?:the user )?before)\b/i;

export function extractRules(text: string): ExtractedRule[] {
  const out: ExtractedRule[] = [];
  const lines = text.split("\n");
  lines.forEach((raw, i) => {
    // split a line into sentences, keep line offset
    const sentences = raw.split(/(?<=[.!?])\s+(?=[A-Z])/);
    for (const s of sentences) {
      const t = s.replace(/^\s*[-*\d.)]+\s*/, "").trim();
      if (t.length < 8) continue;
      const m = RULE_RE.exec(t);
      if (!m) continue;
      const w = m[1].toLowerCase();
      const polarity = /never|do not|don't|must not|mustn't|cannot|without/.test(w) ? "prohibition" : /only/.test(w) ? "restriction" : "obligation";
      out.push({ text: t, lineOffset: i, polarity });
    }
  });
  return out;
}

const STOP = new Set(
  "the a an and or of to in on for with without be is are was any all your you this that from by as at it its into than then when what which who use using used only never always must not do don't before after more less over under about their there have has can will should would may".split(
    " ",
  ),
);

const SYNONYMS: Record<string, string[]> = {
  delete: ["rm", "remove", "unlink", "delete", "deleting", "deletion", "fs.delete"],
  workspace: ["workspace", "path"],
  shell: ["shell", "command", "exec", "process", "run_shell"],
  allow: ["allow", "allowed", "permit", "allowlist"],
  refund: ["refund", "refunds", "issue_refund", "financial"],
  approval: ["approval", "approve", "approved", "manager"],
  ask: ["ask", "confirm"],
  fetch: ["fetch", "url", "host", "network", "fetch_url"],
  hosts: ["host", "hosts", "allowed", "fetch_url"],
  read: ["read", "readfile", "read_file", "fs.read"],
  email: ["email", "e-mail", "mail", "sendmail", "email_customer", "messaging"],
  depth: ["depth", "max_depth"],
};

/** Keywords for a rule: expanded with synonyms (the guard side is not expanded). */
export function ruleKeywords(text: string): Set<string> {
  const k = keywords(text, true);
  if (/\b(more than|over|exceed|at most|up to|maximum|greater than)\b/i.test(text)) ["limit", "max", "exceed"].forEach((x) => k.add(x));
  return k;
}

export function keywords(text: string, expand = false): Set<string> {
  const base = text
    .replace(/\\[bBsSwWdD][+*?]?/g, " ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .replace(/e-mail/g, "email")
    .split(/[^a-z0-9_.]+/)
    .flatMap((w) => [w, ...w.split(/[_.]/)])
    .map((w) => w.replace(/^\.+|\.+$/g, ""))
    .filter((w) => w.length >= 3 && !STOP.has(w));
  const out = new Set<string>();
  for (const w of base) {
    const stem = stemOf(w);
    out.add(w);
    if (stem.length >= 3) out.add(stem);
    if (expand) for (const [k, syn] of Object.entries(SYNONYMS)) if (k === w || k === stem || syn.includes(w)) syn.forEach((s) => out.add(s));
  }
  return out;
}

/** Collapse synonyms to one canonical key so a synonym group counts once. */
export function canonical(word: string): string {
  const root = stemOf(word);
  for (const [k, syn] of Object.entries(SYNONYMS)) if (k === word || k === root || syn.includes(word)) return k;
  return root;
}

export function stemOf(w: string): string {
  return w.replace(/(ing|ed)$/, "").replace(/([^s])s$/, "$1");
}

export function numbersIn(text: string): number[] {
  return [...text.matchAll(/\$?\b(\d[\d_,]*(?:\.\d+)?)\b/g)].map((m) => Number(m[1].replace(/[_,]/g, ""))).filter((n) => Number.isFinite(n));
}

export function overlap(a: Set<string>, b: Set<string>): string[] {
  return [...a].filter((x) => b.has(x)).sort();
}
