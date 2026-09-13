import { spawn } from "node:child_process";
import { render } from "./suite.js";

/**
 * Every provider returns { text, latencyMs, usage: {input, output} | null, raw? }.
 * No SDKs: plain fetch against the OpenAI-compatible and Anthropic HTTP APIs.
 */
export async function complete(cfg, messages, vars, { timeout = 60, fetchImpl = fetch, env = process.env } = {}) {
  const system = cfg.system ? render(cfg.system, vars) : "";
  const msgs = messages.map((m) => ({ role: m.role, content: render(m.content, vars) }));
  const started = performance.now();
  const done = (out) => ({ ...out, latencyMs: Math.round(performance.now() - started) });
  const key = (defEnv) => { const e = cfg.api_key_env || defEnv; const k = env[e]; if (!k && cfg.provider !== "openai") throw new Error(`missing API key: set ${e}`); return k ?? ""; };
  const signal = AbortSignal.timeout(timeout * 1000);
  const headers = { "content-type": "application/json", ...cfg.headers };

  if (cfg.provider === "mock") {
    const last = msgs[msgs.length - 1]?.content ?? "";
    const r = cfg.responses;
    const text = r == null ? last : typeof r === "string" ? r : Array.isArray(r) ? (r.find((x) => x.match && new RegExp(x.match, "i").test(last))?.text ?? r.find((x) => !x.match)?.text ?? "") : (r[last] ?? r["*"] ?? "");
    return done({ text: String(text), usage: null });
  }
  if (cfg.provider === "command") {
    const input = JSON.stringify({ system, messages: msgs, vars });
    return done(await runCommand(cfg.command, input, timeout));
  }
  if (cfg.provider === "openai") {
    const base = (cfg.base_url || env.OPENAI_BASE_URL || "https://api.openai.com/v1").replace(/\/$/, "");
    const k = key("OPENAI_API_KEY"); if (k) headers.authorization = `Bearer ${k}`;
    const body = { model: cfg.model, messages: [...(system ? [{ role: "system", content: system }] : []), ...msgs], temperature: cfg.temperature, max_tokens: cfg.max_tokens, ...cfg.extra };
    const res = await fetchImpl(`${base}/chat/completions`, { method: "POST", headers, body: JSON.stringify(body), signal });
    if (!res.ok) throw new Error(`${cfg.provider} ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const j = await res.json();
    const c = j.choices?.[0]?.message?.content;
    return done({ text: typeof c === "string" ? c : Array.isArray(c) ? c.map((p) => p.text ?? "").join("") : "", usage: j.usage ? { input: j.usage.prompt_tokens ?? 0, output: j.usage.completion_tokens ?? 0 } : null });
  }
  if (cfg.provider === "anthropic") {
    const base = (cfg.base_url || env.ANTHROPIC_BASE_URL || "https://api.anthropic.com").replace(/\/$/, "");
    headers["x-api-key"] = key("ANTHROPIC_API_KEY"); headers["anthropic-version"] = "2023-06-01";
    const body = { model: cfg.model, max_tokens: cfg.max_tokens, temperature: cfg.temperature, ...(system ? { system } : {}), messages: msgs.filter((m) => m.role !== "system"), ...cfg.extra };
    const res = await fetchImpl(`${base}/v1/messages`, { method: "POST", headers, body: JSON.stringify(body), signal });
    if (!res.ok) throw new Error(`${cfg.provider} ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const j = await res.json();
    return done({ text: (j.content ?? []).filter((p) => p.type === "text").map((p) => p.text).join(""), usage: j.usage ? { input: j.usage.input_tokens ?? 0, output: j.usage.output_tokens ?? 0 } : null });
  }
  throw new Error(`unknown provider ${cfg.provider}`);
}

/** Run a shell command with the request JSON on stdin; stdout is the answer. Lets any agent/CLI be tested. */
function runCommand(command, input, timeout) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, { shell: true, stdio: ["pipe", "pipe", "pipe"] });
    let out = "", err = "";
    const timer = setTimeout(() => { child.kill(); reject(new Error(`command timed out after ${timeout}s`)); }, timeout * 1000);
    child.stdout.on("data", (d) => { if (out.length < 4 * 1024 * 1024) out += d; });
    child.stderr.on("data", (d) => { if (err.length < 64 * 1024) err += d; });
    child.on("error", (e) => { clearTimeout(timer); reject(e); });
    child.on("close", (code) => { clearTimeout(timer); code === 0 ? resolve({ text: out.replace(/\r?\n$/, ""), usage: null }) : reject(new Error(`command exited ${code}: ${err.trim().slice(0, 300)}`)); });
    child.stdin.end(input);
  });
}
