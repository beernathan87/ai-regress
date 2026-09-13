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

export function validateSuite(raw, baseDir = ".") {
  if (!raw || typeof raw !== "object") throw new Error("suite must be a mapping with configs and cases");
  const suite = { name: String(raw.name ?? "suite"), configs: {}, cases: [], defaults: { timeout: 60, retries: 1, concurrency: 4 }, judge: raw.judge ? String(raw.judge) : null };
  for (const [k, v] of Object.entries(raw.defaults ?? {})) suite.defaults[k] = v;
  if (!raw.configs || typeof raw.configs !== "object" || !Object.keys(raw.configs).length) throw new Error("configs: at least one prompt/model configuration is required");
  for (const [name, c] of Object.entries(raw.configs)) {
    if (!/^[\w.-]+$/.test(name)) throw new Error(`configs.${name}: name must be [A-Za-z0-9_.-]`);
    const cfg = { name, provider: String(c.provider ?? "openai"), model: c.model ? String(c.model) : "", system: c.system ? String(c.system) : "", temperature: c.temperature ?? 0, max_tokens: c.max_tokens ?? 1024, base_url: c.base_url ? String(c.base_url) : "", api_key_env: c.api_key_env ? String(c.api_key_env) : "", command: c.command ? String(c.command) : "", responses: c.responses ?? null, headers: c.headers ?? {}, extra: c.extra ?? {} };
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
    const id = String(c.id ?? `case-${i + 1}`);
    if (ids.has(id)) throw new Error(`${where}.id: duplicate "${id}"`);
    ids.add(id);
    let messages;
    if (Array.isArray(c.messages)) messages = c.messages.map((m, j) => { if (!m?.role || m.content === undefined) throw new Error(`${where}.messages[${j}]: role and content required`); return { role: String(m.role), content: String(m.content) }; });
    else if (c.input !== undefined) messages = [{ role: "user", content: String(c.input) }];
    else if (c.input_file) messages = [{ role: "user", content: readFileSync(resolve(baseDir, String(c.input_file)), "utf8") }];
    else throw new Error(`${where}: input, input_file or messages required`);
    const vars = c.vars && typeof c.vars === "object" ? c.vars : {};
    const asserts = [].concat(c.assert ?? c.asserts ?? c.expect ?? []).map((a, j) => {
      if (typeof a === "string") a = { contains: a };
      if (!a || typeof a !== "object") throw new Error(`${where}.assert[${j}]: expected a mapping like { contains: "text" }`);
      const keys = Object.keys(a).filter((k) => ASSERTIONS.includes(k));
      if (keys.length !== 1) throw new Error(`${where}.assert[${j}]: exactly one of ${ASSERTIONS.join(", ")}`);
      return { type: keys[0], value: a[keys[0]], weight: Number(a.weight ?? 1), name: a.name ? String(a.name) : null };
    });
    if (!asserts.length) throw new Error(`${where}: at least one assertion`);
    suite.cases.push({ id, messages, vars, asserts, tags: [].concat(c.tags ?? []).map(String), only: [].concat(c.configs ?? []).map(String), description: c.description ? String(c.description) : "" });
  }
  return suite;
}

/** {{var}} substitution in message content and system prompt. */
export const render = (text, vars) => String(text).replace(/\{\{\s*([\w.]+)\s*\}\}/g, (m, k) => (k in vars ? String(vars[k]) : m));
