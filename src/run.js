import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, existsSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import { complete } from "./providers.js";
import { evaluate, judge as judgeFn } from "./assert.js";
import { render } from "./suite.js";

const hash = (o) => createHash("sha256").update(JSON.stringify(o)).digest("hex").slice(0, 24);

/**
 * Run every (config × case) pair with bounded concurrency. Responses are cached on disk by
 * hash(config, messages, vars) so re-runs and baseline comparisons don't re-bill.
 */
export async function runSuite(suite, { configs = Object.keys(suite.configs), cacheDir = ".ai-regress-cache", cache = true, filter = null, tags = [], fetchImpl, env, onResult = () => {}, now = () => new Date() } = {}) {
  configs = [...new Set(configs)];
  for (const c of configs) if (!Object.hasOwn(suite.configs, c)) throw new Error(`unknown config "${c}" (have ${Object.keys(suite.configs).join(", ")})`);
  if (cache) mkdirSync(cacheDir, { recursive: true });
  const cases = suite.cases.filter((c) => (!filter || c.id.includes(filter) || new RegExp(filter).test(c.id)) && (!tags.length || tags.some((t) => c.tags.includes(t))));
  const jobs = [];
  for (const cfgName of configs) for (const c of cases) if (!c.only.length || c.only.includes(cfgName)) jobs.push({ cfgName, c });
  if (!jobs.length) throw new Error("selection matched no cases/configs");
  const results = [];
  const ask = async (cfg, messages, vars) => {
    const runtimeEnv = env ?? process.env;
    const endpoint = cfg.base_url || (cfg.provider === "openai" ? runtimeEnv.OPENAI_BASE_URL : cfg.provider === "anthropic" ? runtimeEnv.ANTHROPIC_BASE_URL : "");
    const credential = runtimeEnv[cfg.api_key_env || (cfg.provider === "anthropic" ? "ANTHROPIC_API_KEY" : "OPENAI_API_KEY")];
    const key = hash({ version: 2, endpoint, credential, cwd: cfg.provider === "command" ? process.cwd() : undefined, cfg: { ...cfg, name: undefined }, messages, vars });
    const file = join(cacheDir, key + ".json");
    if (cache && existsSync(file)) { try { const value = JSON.parse(readFileSync(file, "utf8")); if (typeof value?.text === "string" && Number.isFinite(value.latencyMs) && value.latencyMs >= 0 && (value.usage === null || (Number.isFinite(value.usage?.input) && Number.isFinite(value.usage?.output)))) return { ...value, cached: true }; } catch { /* rewrite */ } }
    let lastErr;
    for (let attempt = 0; attempt <= (suite.defaults.retries ?? 1); attempt++) {
      try {
        const out = await complete(cfg, messages, vars, { timeout: suite.defaults.timeout, fetchImpl, env });
        if (cache) {
          const tmp = `${file}.${randomUUID()}.tmp`;
          try { writeFileSync(tmp, JSON.stringify({ text: out.text, latencyMs: out.latencyMs, usage: out.usage, at: now().toISOString() })); renameSync(tmp, file); }
          finally { rmSync(tmp, { force: true }); }
        }
        return { ...out, cached: false };
      } catch (e) { lastErr = e; if (e.retryable === false || /missing API key|unknown provider|command|unsupported|invalid response/.test(e.message)) break;
        if (attempt < suite.defaults.retries) await new Promise(resolve => setTimeout(resolve, Math.min(200 * 2 ** attempt, 2000))); }
    }
    throw lastErr;
  };
  const judgeCfg = suite.judge ? suite.configs[suite.judge] : null;

  let i = 0;
  const worker = async () => {
    while (i < jobs.length) {
      const { cfgName, c } = jobs[i++];
      const cfg = suite.configs[cfgName];
      const r = { config: cfgName, case: c.id, tags: c.tags, pass: false, error: null, output: "", latencyMs: null, usage: null, cached: false, assertions: [] };
      try {
        const out = await ask(cfg, c.messages, c.vars);
        r.output = out.text; r.latencyMs = out.latencyMs; r.usage = out.usage; r.cached = out.cached;
        for (const a of c.asserts) {
          let res;
          if (a.type === "judge") {
            if (!judgeCfg) res = { pass: false, detail: "no judge config in suite (set `judge: <config name>`)" };
            else { const input = c.messages.map((m) => `${m.role}: ${render(m.content, c.vars)}`).join("\n"); res = await judgeFn(render(String(a.value), c.vars), out.text, input, async (prompt) => (await ask(judgeCfg, [{ role: "user", content: prompt }], {})).text); }
          } else res = evaluate({ ...a, value: typeof a.value === "string" ? render(a.value, c.vars) : a.value }, out.text, { latencyMs: out.latencyMs, cached: out.cached });
          r.assertions.push({ type: a.type, name: a.name, pass: res.pass, detail: res.detail, weight: a.weight });
        }
        r.pass = r.assertions.every((x) => x.pass);
        const totalWeight = r.assertions.reduce((s, x) => s + x.weight, 0);
        r.score = totalWeight ? r.assertions.reduce((s, x) => s + (x.pass ? x.weight : 0), 0) / totalWeight : Number(r.pass);
        // Expected failure (xfail, strict): the case passes when at least one assertion fails; an unexpected pass
        // is reported as a failure so a fixed behaviour gets its expectation removed. Provider errors stay errors.
        if (c.expectedFailure) {
          r.expectedFailure = true;
          if (r.pass) { r.pass = false; r.score = 0; r.assertions.push({ type: "expected_failure", name: null, pass: false, detail: "expected to fail but every assertion passed - remove expected_failure", weight: 0 }); }
          else { r.pass = true; r.score = 1; }
        }
      } catch (e) { r.error = e.message; r.score = 0; }
      results.push(r); onResult(r);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(suite.defaults.concurrency ?? 4, jobs.length)) }, worker));
  results.sort((a, b) => configs.indexOf(a.config) - configs.indexOf(b.config) || cases.findIndex((x) => x.id === a.case) - cases.findIndex((x) => x.id === b.case));
  return summarize(suite, configs, results, now());
}

export function summarize(suite, configs, results, at = new Date()) {
  const perConfig = Object.create(null);
  for (const c of configs) { const rs = results.filter((r) => r.config === c); perConfig[c] = { total: rs.length, passed: rs.filter((r) => r.pass).length, failed: rs.filter((r) => !r.pass && !r.error).length, errors: rs.filter((r) => r.error).length, score: rs.length ? rs.reduce((s, r) => s + (r.score ?? 0), 0) / rs.length : 0, avgLatencyMs: avg(rs.map((r) => r.latencyMs).filter((x) => x != null)), tokens: rs.reduce((s, r) => s + (r.usage ? r.usage.input + r.usage.output : 0), 0) }; }
  // Compare the first config with each later config; errors count as failures.
  const regressions = [], improvements = [];
  if (configs.length >= 2) {
    const [base, ...rest] = configs;
    for (const r of results.filter((x) => x.config === base)) for (const other of rest) {
      const o = results.find((x) => x.config === other && x.case === r.case); if (!o) continue;
      if (r.pass && !o.pass) regressions.push({ case: r.case, from: base, to: other, detail: o.error ?? o.assertions.filter((a) => !a.pass).map((a) => `${a.type}: ${a.detail}`).join("; ") });
      if (!r.pass && o.pass) improvements.push({ case: r.case, from: base, to: other });
    }
  }
  return { suite: suite.name, at: at.toISOString(), configs, perConfig, results, regressions, improvements };
}

/** Compare a fresh run with a saved baseline (same suite, any configs): per (config, case) pass transitions. */
export function compareBaseline(current, baseline) {
  if (current.suite !== baseline.suite) throw new Error("baseline suite name does not match current suite");
  if (!Array.isArray(baseline.results) || baseline.results.some(r => !r || typeof r.config !== "string" || typeof r.case !== "string" || typeof r.pass !== "boolean")) throw new Error("invalid baseline results");
  const key = (r) => JSON.stringify([r.config, r.case]);
  if (new Set(baseline.results.map(key)).size !== baseline.results.length) throw new Error("duplicate baseline result");
  if (!current.results.some(r => baseline.results.some(p => key(p) === key(r)))) throw new Error("baseline has no matching config/case pairs");
  const prev = new Map((baseline.results ?? []).map((r) => [key(r), r]));
  const regressions = [], fixes = [], added = [];
  for (const r of current.results) {
    const p = prev.get(key(r));
    if (!p) { added.push({ config: r.config, case: r.case }); continue; }
    if (p.pass && !r.pass) regressions.push({ config: r.config, case: r.case, detail: r.error ?? r.assertions.filter((a) => !a.pass).map((a) => `${a.type}: ${a.detail}`).join("; ") });
    if (!p.pass && r.pass) fixes.push({ config: r.config, case: r.case });
  }
  return { baselineAt: baseline.at, regressions, fixes, added, removed: [...prev.keys()].filter((k) => !current.results.some((r) => key(r) === k)).length };
}
const avg = (xs) => (xs.length ? Math.round(xs.reduce((a, b) => a + b, 0) / xs.length) : null);
