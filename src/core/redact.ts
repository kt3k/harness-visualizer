/**
 * Redaction of secrets, credentials and personal data. Applied by default to
 * everything the analyzer writes (prompt text, snippets, copied sources) and
 * to trace attributes on load, and again on export from the UI.
 *
 * Levels:
 *  - standard: mask secrets / credentials / e-mail addresses / phone numbers
 *  - strict:   additionally replace prompt bodies by a content hash
 */
import type { RedactionLevel } from "./ir";

const PATTERNS: { name: string; re: RegExp }[] = [
  { name: "private-key", re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g },
  { name: "api-key", re: /\b(?:sk|pk|rk)[-_](?:live|test|ant|proj)?[-_]?[A-Za-z0-9_-]{16,}\b/g },
  { name: "aws-key", re: /\bAKIA[0-9A-Z]{16}\b/g },
  { name: "github-token", re: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g },
  { name: "slack-token", re: /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g },
  { name: "jwt", re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g },
  { name: "bearer", re: /\bBearer\s+[A-Za-z0-9._~+/-]{16,}=*/g },
  { name: "email", re: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g },
  { name: "phone", re: /(?<![\w-])\+?\d{1,3}[ -]?\(?\d{2,4}\)?[ -]\d{3,4}[ -]\d{3,4}(?![\w-])/g },
];

/** `key = "value"` style assignments where the name suggests a secret. */
const SECRET_ASSIGNMENT =
  /\b([A-Za-z_][A-Za-z0-9_]*(?:key|secret|token|password|passwd|credential|apikey)[A-Za-z0-9_]*)(\s*(?:[:=]|\?\?|\|\|)\s*)(["'`])([^"'`\n]{8,})\3/gi;

export interface RedactionResult {
  text: string;
  redactions: { kind: string; count: number }[];
}

export function redactText(input: string): RedactionResult {
  const counts = new Map<string, number>();
  const bump = (k: string) => counts.set(k, (counts.get(k) ?? 0) + 1);
  let text = input.replace(SECRET_ASSIGNMENT, (_m, name, op, q) => {
    bump("secret-assignment");
    return `${name}${op}${q}«redacted:secret»${q}`;
  });
  for (const p of PATTERNS) {
    text = text.replace(p.re, (m) => {
      if (m.startsWith("«redacted")) return m;
      bump(p.name);
      return `«redacted:${p.name}»`;
    });
  }
  return { text, redactions: [...counts].map(([kind, count]) => ({ kind, count })) };
}

export function redact(input: string): string {
  return redactText(input).text;
}

/** Small deterministic, dependency-free hash (FNV-1a 32-bit, hex) for browser use. */
export function fnv1a(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

export function redactPromptBody(text: string, level: RedactionLevel): string {
  if (level === "strict") return `«prompt body withheld (strict redaction); fnv1a=${fnv1a(text)}, ${text.length} chars»`;
  return redact(text);
}

/** Deep-redact all string values of a JSON-like value. */
export function redactDeep<T>(value: T, level: RedactionLevel = "standard"): T {
  const walk = (v: unknown, key?: string): unknown => {
    if (typeof v === "string") {
      if (level === "strict" && key && /^(text|body|snippet|content|prompt|outputSummary|inputSummary)$/.test(key) && v.length > 40) {
        return redactPromptBody(v, "strict");
      }
      return redact(v);
    }
    if (Array.isArray(v)) return v.map((x) => walk(x));
    if (v && typeof v === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, x] of Object.entries(v)) out[k] = walk(x, k);
      return out;
    }
    return v;
  };
  return walk(value) as T;
}
