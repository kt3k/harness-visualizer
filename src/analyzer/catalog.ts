/**
 * Catalog of known external APIs. The analyzer only classifies a call as a
 * model call / effect / state access when the resolved callee matches an
 * entry here. Everything else from an uncatalogued package is reported as
 * Unknown — the catalog bounds what the tool can claim.
 *
 * Paths are the resolved member chain from the import binding:
 *   "default" = default import, "new" = constructor call, "()" = call result.
 */

export type ApiClass = "model" | "effect" | "approval" | "db" | "pure";

export interface ApiRule {
  id: string;
  module?: string;
  global?: string;
  path: string[];
  cls: ApiClass;
  api: string;
  provider?: string;
  category?: string;
  irreversible?: boolean | "unknown";
  /** for fs operations that may be state stores */
  fsOp?: "read" | "write" | "delete";
  target?: string;
}

const fsPromises = (name: string, op: "read" | "write" | "delete", category: string, irreversible: boolean | "unknown"): ApiRule[] => [
  { id: `fs.promises.${name}`, module: "node:fs/promises", path: [name], cls: "effect", api: `fs.promises.${name}`, category, irreversible, fsOp: op, target: "filesystem" },
  { id: `fs.${name}`, module: "node:fs", path: [name], cls: "effect", api: `fs.${name}`, category, irreversible, fsOp: op, target: "filesystem" },
  { id: `fs.${name}Sync`, module: "node:fs", path: [`${name}Sync`], cls: "effect", api: `fs.${name}Sync`, category, irreversible, fsOp: op, target: "filesystem" },
];

export const API_RULES: ApiRule[] = [
  // --- model providers -----------------------------------------------------
  { id: "anthropic.messages.create", module: "@anthropic-ai/sdk", path: ["default", "new", "messages", "create"], cls: "model", api: "messages.create", provider: "anthropic" },
  { id: "anthropic.messages.create#named", module: "@anthropic-ai/sdk", path: ["Anthropic", "new", "messages", "create"], cls: "model", api: "messages.create", provider: "anthropic" },
  { id: "openai.chat.completions.create", module: "openai", path: ["default", "new", "chat", "completions", "create"], cls: "model", api: "chat.completions.create", provider: "openai" },
  { id: "openai.responses.create", module: "openai", path: ["default", "new", "responses", "create"], cls: "model", api: "responses.create", provider: "openai" },

  // --- filesystem ----------------------------------------------------------
  ...fsPromises("readFile", "read", "fs.read", false),
  ...fsPromises("readdir", "read", "fs.read", false),
  ...fsPromises("writeFile", "write", "fs.write", "unknown"),
  ...fsPromises("appendFile", "write", "fs.write", false),
  ...fsPromises("mkdir", "write", "fs.write", false),
  ...fsPromises("rename", "write", "fs.write", "unknown"),
  ...fsPromises("rm", "delete", "fs.delete", true),
  ...fsPromises("unlink", "delete", "fs.delete", true),
  ...fsPromises("rmdir", "delete", "fs.delete", true),

  // --- processes -----------------------------------------------------------
  ...["exec", "execFile", "spawn", "execSync", "execFileSync", "spawnSync", "fork"].map(
    (n): ApiRule => ({ id: `child_process.${n}`, module: "node:child_process", path: [n], cls: "effect", api: `child_process.${n}`, category: "process.exec", irreversible: "unknown", target: "shell" }),
  ),

  // --- network -------------------------------------------------------------
  { id: "fetch", global: "fetch", path: [], cls: "effect", api: "fetch", category: "network", irreversible: "unknown" },

  // --- payments / messaging -----------------------------------------------
  { id: "stripe.refunds.create", module: "stripe", path: ["default", "new", "refunds", "create"], cls: "effect", api: "stripe.refunds.create", category: "financial", irreversible: true, target: "Stripe API" },
  { id: "stripe.charges.create", module: "stripe", path: ["default", "new", "charges", "create"], cls: "effect", api: "stripe.charges.create", category: "financial", irreversible: true, target: "Stripe API" },
  { id: "nodemailer.sendMail", module: "nodemailer", path: ["default", "createTransport", "()", "sendMail"], cls: "effect", api: "nodemailer.sendMail", category: "messaging", irreversible: true, target: "SMTP" },

  // --- databases (classified as state read/write by SQL verb) ---------------
  { id: "pg.Pool.query", module: "pg", path: ["Pool", "new", "query"], cls: "db", api: "pg.query", target: "postgres" },
  { id: "pg.Client.query", module: "pg", path: ["Client", "new", "query"], cls: "db", api: "pg.query", target: "postgres" },

  // --- human input ---------------------------------------------------------
  { id: "readline.question", module: "node:readline/promises", path: ["createInterface", "()", "question"], cls: "approval", api: "readline.question" },
  { id: "readline.question#cb", module: "node:readline", path: ["createInterface", "()", "question"], cls: "approval", api: "readline.question" },
];

/** Modules whose remaining (non-matching) members are known to be side-effect free or irrelevant. */
export const KNOWN_MODULES = new Set([
  "@anthropic-ai/sdk",
  "openai",
  "node:fs",
  "node:fs/promises",
  "node:child_process",
  "node:path",
  "node:util",
  "node:url",
  "node:os",
  "node:crypto",
  "node:readline",
  "node:readline/promises",
  "stripe",
  "nodemailer",
  "pg",
]);

export const NODE_BUILTINS = new Set([
  "fs", "fs/promises", "path", "child_process", "util", "url", "os", "crypto", "readline", "readline/promises", "http", "https", "net", "stream", "events", "process",
]);

/** Global functions / namespaces that are pure (for our purposes). */
export const PURE_GLOBALS = new Set([
  "JSON", "Math", "Object", "Array", "String", "Number", "Boolean", "Promise", "console", "Date", "setTimeout", "clearTimeout",
  "setInterval", "clearInterval", "URL", "encodeURIComponent", "decodeURIComponent", "Error", "Set", "Map", "parseInt", "parseFloat",
  "structuredClone", "Symbol", "RegExp", "BigInt", "AbortController", "TypeError", "RangeError",
]);

/** Common pure methods on values whose origin we do not resolve. */
export const PURE_METHODS = new Set([
  "push", "map", "filter", "find", "some", "every", "join", "slice", "splice", "concat", "includes", "indexOf", "reduce", "flatMap",
  "forEach", "sort", "reverse", "keys", "values", "entries", "has", "get", "set", "add", "delete", "trim", "split", "startsWith",
  "endsWith", "toLowerCase", "toUpperCase", "replace", "replaceAll", "test", "match", "toString", "padStart", "padEnd", "at", "text",
  "json", "then", "catch", "finally", "close", "abort", "resolve", "stringify", "parse", "now", "isArray", "assign", "fromEntries",
]);

export function normalizeModule(spec: string): string {
  if (spec.startsWith("node:")) return spec;
  if (NODE_BUILTINS.has(spec)) return `node:${spec}`;
  return spec;
}

export function normalizePath(module: string, path: string[]): { module: string; path: string[] } {
  let p = [...path];
  if (module.startsWith("node:") && p[0] === "default") p = p.slice(1);
  if (module === "node:fs" && p[0] === "promises") return { module: "node:fs/promises", path: p.slice(1) };
  return { module, path: p };
}

export function matchRule(module: string | undefined, global: string | undefined, path: string[]): ApiRule | undefined {
  return API_RULES.find((r) => {
    if (r.global) return global === r.global && r.path.length === path.length && r.path.every((s, i) => s === path[i]);
    if (r.module !== module) return false;
    return r.path.length === path.length && r.path.every((s, i) => s === "*" || s === path[i]);
  });
}
