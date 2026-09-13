import { spawn } from "node:child_process";
import { render } from "./suite.js";

/**
 * Every provider returns { text, latencyMs, usage: {input, output} | null, raw? }.
 * No SDKs: plain fetch against the OpenAI-compatible and Anthropic HTTP APIs.
 */
export async function complete(cfg, messages, vars, { timeout = 60, fetchImpl = fetch, env = process.env } = {}) {
  let system = cfg.system ? render(cfg.system, vars) : "";
  const msgs = messages.map((m) => ({ role: m.role, content: render(m.content, vars) }));
  const started = performance.now();
  const done = (out) => ({ ...out, latencyMs: Math.round(performance.now() - started) });
  // An explicitly named api_key_env must exist; the OpenAI default may be absent (keyless local servers).
  const key = (defEnv) => { const e = cfg.api_key_env || defEnv; const k = env[e]; if (!k && (cfg.provider !== "openai" || cfg.api_key_env)) throw new Error(`missing API key: set ${e}`); return k ?? ""; };
  // Never let a provider's error body echo the credential into reports/logs.
  const redact = (text) => { let t = String(text); for (const k of [env[cfg.api_key_env || "OPENAI_API_KEY"], env[cfg.api_key_env || "ANTHROPIC_API_KEY"]]) if (k && k.length >= 8) t = t.split(k).join("[redacted]"); return t; };
  const signal = AbortSignal.timeout(Math.ceil(timeout * 1000));
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
    for (const k of ["temperature", "max_tokens"]) if (body[k] == null) delete body[k];
    if (body.max_completion_tokens != null) delete body.max_tokens;
    const res = await fetchImpl(`${base}/chat/completions`, { method: "POST", headers, body: JSON.stringify(body), signal });
    if (!res.ok) { const error = new Error(`${cfg.provider} ${res.status}: ${redact((await res.text()).slice(0, 300))}`); error.retryable = res.status === 429 || res.status === 408 || res.status >= 500; throw error; }
    const j = await res.json();
    const message = j.choices?.[0]?.message;
    const c = message?.content;
    if (typeof c !== "string" && !(Array.isArray(c) && c.every(p => p.type === "text" && typeof p.text === "string"))) throw new Error("invalid response: openai requires text content (tool-only/refusal-only responses unsupported)");
    return done({ text: typeof c === "string" ? c : Array.isArray(c) ? c.map((p) => p.text ?? "").join("") : "", usage: j.usage ? { input: j.usage.prompt_tokens ?? 0, output: j.usage.completion_tokens ?? 0 } : null });
  }
  if (cfg.provider === "anthropic") {
    const base = (cfg.base_url || env.ANTHROPIC_BASE_URL || "https://api.anthropic.com").replace(/\/$/, "");
    headers["x-api-key"] = key("ANTHROPIC_API_KEY"); headers["anthropic-version"] = "2023-06-01";
    const conversation = [...msgs];
    const leading = [];
    while (conversation[0]?.role === "system") leading.push(conversation.shift().content);
    system = [system, ...leading].filter(Boolean).join("\n\n");
    if (conversation[0]?.role !== "user" || conversation.some(m => !["user", "assistant"].includes(m.role))) throw new Error("unsupported anthropic messages: start with user; put system instructions at the start or in config.system");
    const body = { model: cfg.model, max_tokens: cfg.max_tokens, temperature: cfg.temperature, ...(system ? { system } : {}), messages: conversation, ...cfg.extra };
    if (body.temperature == null) delete body.temperature;
    const res = await fetchImpl(`${base}/v1/messages`, { method: "POST", headers, body: JSON.stringify(body), signal });
    if (!res.ok) { const error = new Error(`${cfg.provider} ${res.status}: ${redact((await res.text()).slice(0, 300))}`); error.retryable = res.status === 429 || res.status === 408 || res.status >= 500; throw error; }
    const j = await res.json();
    if (!Array.isArray(j.content) || !j.content.some(p => p.type === "text" && typeof p.text === "string") || j.content.some(p => p.type === "text" && typeof p.text !== "string")) throw new Error("invalid response: anthropic requires text content");
    return done({ text: (j.content ?? []).filter((p) => p.type === "text").map((p) => p.text).join(""), usage: j.usage ? { input: j.usage.input_tokens ?? 0, output: j.usage.output_tokens ?? 0 } : null });
  }
  throw new Error(`unknown provider ${cfg.provider}`);
}

/** Run a shell command with the request JSON on stdin; stdout is the answer. Lets any agent/CLI be tested. */
function runCommand(command, input, timeout) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, { shell: true, windowsHide: true, detached: process.platform !== "win32", stdio: ["pipe", "pipe", "pipe"] });
    let out = "", err = "", bytes = 0;
    const decoder = new TextDecoder("utf-8", { fatal: true });
    const stop = () => {
      if (!child.pid) return;
      if (process.platform === "win32") { const killer = spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" }); killer.on("error", () => child.kill()); }
      else { try { process.kill(-child.pid, "SIGKILL"); } catch { child.kill(); } }
    };
    const fail = (error) => { clearTimeout(timer); stop(); reject(error); };
    const timer = setTimeout(() => fail(new Error(`command timed out after ${timeout}s`)), timeout * 1000);
    child.stdout.on("data", (d) => {
      bytes += d.length;
      if (bytes > 4 * 1024 * 1024) return fail(new Error("command stdout exceeded 4 MiB"));
      try { out += decoder.decode(d, { stream: true }); } catch { fail(new Error("command stdout must be UTF-8")); }
    });
    child.stderr.on("data", (d) => { if (err.length < 64 * 1024) err += d; });
    child.on("error", (e) => { clearTimeout(timer); reject(e); });
    child.stdin.on("error", (e) => { if (e.code !== "EPIPE") fail(e); });
    child.on("close", (code) => { clearTimeout(timer); try { out += decoder.decode(); } catch { reject(new Error("command stdout must be UTF-8")); return; } code === 0 ? resolve({ text: out.replace(/\r?\n$/, ""), usage: null }) : reject(new Error(`command exited ${code}: ${err.trim().slice(0, 300)}`)); });
    child.stdin.end(input);
  });
}
