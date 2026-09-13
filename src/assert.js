/** Deterministic assertions. Each returns { pass, detail }. The judge assertion is async and needs a judge function. */
const REFUSAL = /\b(as an ai|i(?:'m| am) (?:unable|not able) to|i can(?:'t|not) (?:help|assist|provide|do that)|i'm sorry,? but|i cannot comply|against my (?:guidelines|policy))\b/i;
const tokens = (s) => new Set(String(s).toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []);
export const similarity = (a, b) => { const A = tokens(a), B = tokens(b); if (!A.size && !B.size) return 1; let inter = 0; for (const t of A) if (B.has(t)) inter++; return inter / (A.size + B.size - inter); };
const jsonOf = (text) => { const t = String(text).trim().replace(/^```(?:json)?\s*|\s*```$/g, ""); try { return JSON.parse(t); } catch { const m = t.match(/[\[{][\s\S]*[\]}]/); if (m) { try { return JSON.parse(m[0]); } catch { /* no */ } } return undefined; } };
const path = (obj, p) => String(p).split(".").filter(Boolean).reduce((o, k) => (o == null ? undefined : o[k]), obj);
const list = (v) => [].concat(v).map(String);
const short = (s, n = 80) => { s = String(s).replace(/\s+/g, " "); return s.length > n ? s.slice(0, n - 1) + "…" : s; };

export function evaluate(a, output, meta = {}) {
  const v = a.value, text = String(output ?? "");
  switch (a.type) {
    case "contains": { const miss = list(v).filter((s) => !text.includes(s)); return { pass: !miss.length, detail: miss.length ? `missing ${miss.map((m) => JSON.stringify(m)).join(", ")}` : "found" }; }
    case "icontains": { const miss = list(v).filter((s) => !text.toLowerCase().includes(s.toLowerCase())); return { pass: !miss.length, detail: miss.length ? `missing ${miss.map((m) => JSON.stringify(m)).join(", ")}` : "found" }; }
    case "not_contains": { const hit = list(v).filter((s) => text.toLowerCase().includes(s.toLowerCase())); return { pass: !hit.length, detail: hit.length ? `found forbidden ${hit.map((m) => JSON.stringify(m)).join(", ")}` : "absent" }; }
    case "regex": { const re = new RegExp(String(v), "s"); return { pass: re.test(text), detail: re.test(text) ? "matched" : `no match for /${v}/` }; }
    case "not_regex": { const re = new RegExp(String(v), "s"); return { pass: !re.test(text), detail: re.test(text) ? `matched forbidden /${v}/` : "no match" }; }
    case "equals": return { pass: text.trim() === String(v).trim(), detail: text.trim() === String(v).trim() ? "equal" : `got ${JSON.stringify(short(text))}` };
    case "iequals": return { pass: text.trim().toLowerCase() === String(v).trim().toLowerCase(), detail: `got ${JSON.stringify(short(text))}` };
    case "starts_with": return { pass: text.trimStart().startsWith(String(v)), detail: `starts ${JSON.stringify(short(text, 30))}` };
    case "ends_with": return { pass: text.trimEnd().endsWith(String(v)), detail: `ends ${JSON.stringify(short(text.slice(-30), 30))}` };
    case "one_of": { const ok = list(v).some((s) => text.trim() === s.trim()); return { pass: ok, detail: ok ? "matched" : `got ${JSON.stringify(short(text))}` }; }
    case "min_length": return { pass: text.length >= Number(v), detail: `${text.length} chars` };
    case "max_length": return { pass: text.length <= Number(v), detail: `${text.length} chars` };
    case "min_words": { const n = (text.match(/\S+/g) ?? []).length; return { pass: n >= Number(v), detail: `${n} words` }; }
    case "max_words": { const n = (text.match(/\S+/g) ?? []).length; return { pass: n <= Number(v), detail: `${n} words` }; }
    case "not_empty": return { pass: text.trim().length > 0, detail: text.trim() ? "non-empty" : "empty output" };
    case "no_refusal": { const m = text.match(REFUSAL); return { pass: !m, detail: m ? `refusal phrase ${JSON.stringify(m[0])}` : "no refusal" }; }
    case "json": { const j = jsonOf(text); if (j === undefined) return { pass: false, detail: "output is not valid JSON" }; if (v === true || v === undefined) return { pass: true, detail: "valid JSON" }; const bad = typeCheck(j, v); return { pass: !bad, detail: bad ?? "valid JSON matching shape" }; }
    case "json_keys": { const j = jsonOf(text); if (!j || typeof j !== "object") return { pass: false, detail: "output is not a JSON object" }; const miss = list(v).filter((k) => path(j, k) === undefined); return { pass: !miss.length, detail: miss.length ? `missing keys ${miss.join(", ")}` : "keys present" }; }
    case "json_path": { const j = jsonOf(text); if (j === undefined) return { pass: false, detail: "output is not valid JSON" }; const [p, expected] = Array.isArray(v) ? v : [v.path, v.equals]; const got = path(j, p); const ok = expected === undefined ? got !== undefined : JSON.stringify(got) === JSON.stringify(expected); return { pass: ok, detail: ok ? `${p} ok` : `${p} = ${JSON.stringify(got)}` }; }
    case "similar_to": { const ref = typeof v === "string" ? v : v.text; const min = typeof v === "string" ? 0.6 : Number(v.min ?? 0.6); const s = similarity(text, ref); return { pass: s >= min, detail: `similarity ${s.toFixed(2)} (min ${min})` }; }
    case "latency_ms": return { pass: (meta.latencyMs ?? 0) <= Number(v), detail: `${meta.latencyMs ?? "?"} ms (max ${v})` };
    case "judge": return { pass: false, detail: "judge assertion needs a judge config", async: true };
    default: return { pass: false, detail: `unknown assertion ${a.type}` };
  }
}

/** Tiny shape checker: { key: "string" | "number" | "boolean" | "array" | "object" | "string?" } */
function typeCheck(obj, shape) {
  if (typeof shape !== "object" || shape === null) return null;
  if (typeof obj !== "object" || obj === null) return "expected an object";
  for (const [k, t] of Object.entries(shape)) {
    const optional = String(t).endsWith("?"), type = String(t).replace(/\?$/, "");
    const val = obj[k];
    if (val === undefined) { if (optional) continue; return `missing key "${k}"`; }
    const actual = Array.isArray(val) ? "array" : val === null ? "null" : typeof val;
    if (type !== "any" && actual !== type) return `key "${k}" should be ${type}, got ${actual}`;
  }
  return null;
}

/** Ask a judge config a yes/no question about the output. Returns { pass, detail }. */
export async function judge(question, output, input, ask) {
  const prompt = `You are a strict evaluator of AI outputs. Answer ONLY with JSON: {"pass": true|false, "reason": "<one sentence>"}.\n\nQUESTION: ${question}\n\nUSER INPUT:\n${input}\n\nAI OUTPUT:\n${output}`;
  const text = await ask(prompt);
  const j = jsonOf(text);
  if (!j || typeof j.pass !== "boolean") return { pass: false, detail: `judge did not return {pass, reason}: ${short(text)}` };
  return { pass: j.pass, detail: `judge: ${short(j.reason ?? "", 120)}` };
}
