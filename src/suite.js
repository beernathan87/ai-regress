import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import YAML from "yaml";

export const ASSERTIONS = ["contains", "not_contains", "icontains", "regex", "not_regex", "equals", "iequals", "starts_with", "ends_with", "one_of", "min_length", "max_length", "max_words", "min_words", "json", "json_keys", "json_path", "similar_to", "latency_ms", "judge", "not_empty", "no_refusal"];

/** Load and validate a suite file (YAML or JSON). Paths inside are relative to the file. */
export function loadSuite(path) {
  const text = readFileSync(path, "utf8");
  const raw = path.endsWith(".json") ? JSON.parse(text) : YAML.parse(text);
  return validateSuite(raw, dirname(resolve(path)));
}

const mapping = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
function keys(obj, allowed, where) {
  if (!mapping(obj)) throw new Error(`${where}: expected a mapping`);
  for (const k of Object.keys(obj)) if (!allowed.includes(k)) throw new Error(`${where}: unknown key "${k}"`);
}
export function validateSuite(raw, baseDir = ".") {
  keys(raw, ["name", "configs", "cases", "defaults", "judge"], "suite");
  const suite = { name: String(raw.name ?? "suite"), configs: Object.create(null), cases: [], defaults: { timeout: 60, retries: 1, concurrency: 4 }, judge: raw.judge ? String(raw.judge) : null };
  keys(raw.defaults ?? {}, ["timeout", "retries", "concurrency"], "defaults");
  for (const [k, v] of Object.entries(raw.defaults ?? {})) suite.defaults[k] = v;
  for (const k of ["concurrency", "retries"]) if (!Number.isSafeInteger(suite.defaults[k]) || suite.defaults[k] < (k === "retries" ? 0 : 1)) throw new Error(`defaults.${k}: invalid integer`);
  if (!Number.isFinite(suite.defaults.timeout) || suite.defaults.timeout <= 0 || suite.defaults.timeout > 2147483) throw new Error("defaults.timeout: must be positive and <= 2147483 seconds");
  if (!mapping(raw.configs) || !Object.keys(raw.configs).length) throw new Error("configs: at least one prompt/model configuration is required");
  for (const [name, c] of Object.entries(raw.configs)) {
    keys(c, ["provider", "model", "system", "system_file", "temperature", "max_tokens", "base_url", "api_key_env", "command", "responses", "headers", "extra"], `configs.${name}`);
    if (!/^[\w.-]+$/.test(name)) throw new Error(`configs.${name}: name must be [A-Za-z0-9_.-]`);
    const cfg = { name, provider: String(c.provider ?? "openai"), model: c.model ? String(c.model) : "", system: c.system ? String(c.system) : "", temperature: c.temperature === null ? undefined : c.temperature ?? 0, max_tokens: c.max_tokens === null ? undefined : c.max_tokens ?? 1024, base_url: c.base_url ? String(c.base_url) : "", api_key_env: c.api_key_env ? String(c.api_key_env) : "", command: c.command ? String(c.command) : "", responses: c.responses ?? null, headers: c.headers ?? {}, extra: c.extra ?? {} };
    if (!mapping(cfg.headers) || !mapping(cfg.extra)) throw new Error(`configs.${name}: headers and extra must be mappings`);
    if (cfg.extra.stream) throw new Error(`configs.${name}: streaming is unsupported`);
    if (c.system_file) cfg.system = readFileSync(resolve(baseDir, String(c.system_file)), "utf8");
    if (!["openai", "anthropic", "command", "mock"].includes(cfg.provider)) throw new Error(`configs.${name}.provider: openai | anthropic | command | mock`);
    if (["openai", "anthropic"].includes(cfg.provider) && !cfg.model) throw new Error(`configs.${name}.model: required`);
    if (cfg.provider === "command" && !cfg.command) throw new Error(`configs.${name}.command: required for the command provider`);
    suite.configs[name] = cfg;
  }
  if (suite.judge && !suite.configs[suite.judge]) throw new Error(`judge: "${suite.judge}" is not a configured config`);
  if (!Array.isArray(raw.cases) || !raw.cases.length) throw new Error("cases: at least one test case is required");
  const ids = new Set();
  for (const [i, c] of raw.cases.entries()) {
    const where = `cases[${i}]`;
    keys(c, ["id", "input", "input_file", "messages", "vars", "tags", "configs", "description", "assert", "asserts", "expect", "expected_failure"], where);
    if (c.expected_failure !== undefined && typeof c.expected_failure !== "boolean") throw new Error(`${where}.expected_failure: must be true or false`);
    for (const name of [].concat(c.configs ?? [])) if (!Object.hasOwn(suite.configs, name)) throw new Error(`${where}.configs: unknown config "${name}"`);
    const id = String(c.id ?? `case-${i + 1}`);
    if (ids.has(id)) throw new Error(`${where}.id: duplicate "${id}"`);
    ids.add(id);
    let messages;
    if (Array.isArray(c.messages)) messages = c.messages.map((m, j) => { if (!["user", "assistant", "system", "developer"].includes(m?.role) || typeof m.content !== "string") throw new Error(`${where}.messages[${j}]: supported role and string content required`); return { role: String(m.role), content: String(m.content) }; });
    else if (c.input !== undefined) messages = [{ role: "user", content: String(c.input) }];
    else if (c.input_file) messages = [{ role: "user", content: readFileSync(resolve(baseDir, String(c.input_file)), "utf8") }];
    else throw new Error(`${where}: input, input_file or messages required`);
    if (!messages.length) throw new Error(`${where}.messages: must not be empty`);
    const vars = c.vars && typeof c.vars === "object" ? c.vars : {};
    const asserts = [].concat(c.assert ?? c.asserts ?? c.expect ?? []).map((a, j) => {
      if (typeof a === "string") a = { contains: a };
      if (!a || typeof a !== "object") throw new Error(`${where}.assert[${j}]: expected a mapping like { contains: "text" }`);
      const keys = Object.keys(a).filter((k) => ASSERTIONS.includes(k));
      if (keys.length !== 1) throw new Error(`${where}.assert[${j}]: exactly one of ${ASSERTIONS.join(", ")}`);
      for (const k of Object.keys(a)) if (![keys[0], "weight", "name"].includes(k)) throw new Error(`${where}.assert[${j}]: unknown key "${k}"`);
      if (!Number.isFinite(a.weight ?? 1) || (a.weight ?? 1) < 0) throw new Error(`${where}.assert[${j}]: weight must be finite and nonnegative`);
      // Empty expectations pass trivially (every string contains "", matches /(?:)/, starts with "") - reject them.
      for (const v of [].concat(a[keys[0]])) if (["contains", "not_contains", "icontains", "regex", "not_regex", "equals", "iequals", "starts_with", "ends_with", "one_of", "judge"].includes(keys[0]) && (typeof v !== "string" || !v.trim())) throw new Error(`${where}.assert[${j}]: ${keys[0]} needs a non-empty string`);
      if (keys[0] === "json" && a.json !== true && (!mapping(a.json) || Object.values(a.json).some(t => typeof t !== "string" || !/^(string|number|boolean|array|object|any)\??$/.test(t)))) throw new Error(`${where}.assert[${j}]: json requires true or a flat type shape`);
      return { type: keys[0], value: a[keys[0]], weight: Number(a.weight ?? 1), name: a.name ? String(a.name) : null };
    });
    if (!Number.isFinite(asserts.reduce((sum, a) => sum + a.weight, 0))) throw new Error(`${where}: total assertion weight must be finite`);
    if (!asserts.length) throw new Error(`${where}: at least one assertion`);
    suite.cases.push({ id, messages, vars, asserts, tags: [].concat(c.tags ?? []).map(String), only: [].concat(c.configs ?? []).map(String), description: c.description ? String(c.description) : "", expectedFailure: c.expected_failure === true });
  }
  return suite;
}

/** {{var}} substitution in message content and system prompt. */
export const render = (text, vars) => String(text).replace(/\{\{\s*([\w.]+)\s*\}\}/g, (m, k) => (k in vars ? String(vars[k]) : m));
