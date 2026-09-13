const pct = (v) => `${Math.round(v * 100)}%`;
const xmlText = (s) => String(s ?? "").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]/g, "");
const esc = (s) => xmlText(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" }[c]));
const short = (s, n = 100) => { s = String(s ?? "").replace(/\s+/g, " "); return s.length > n ? s.slice(0, n - 1) + "…" : s; };

export function text(sum, cmp) {
  const out = [];
  const cases = [...new Set(sum.results.map((r) => r.case))];
  const w = Math.max(6, ...cases.map((c) => c.length));
  out.push(`${sum.suite}  (${sum.at.replace("T", " ").slice(0, 16)} UTC)`, "");
  out.push(`${"case".padEnd(w)}  ${sum.configs.map((c) => c.padEnd(Math.max(8, c.length))).join("  ")}`);
  for (const c of cases) out.push(`${c.padEnd(w)}  ${sum.configs.map((cfg) => { const r = sum.results.find((x) => x.config === cfg && x.case === c); return (r ? r.error ? "ERR " : r.pass ? (r.expectedFailure ? "xfail" : "pass") : "FAIL" : "-   ").padEnd(Math.max(8, cfg.length)); }).join("  ")}`);
  out.push("");
  if (sum.results.some(r => r.cached)) out.push("Cached responses included: latency and tokens are original measurements; use --no-cache to remeasure.");
  for (const cfg of sum.configs) { const p = sum.perConfig[cfg]; out.push(`${cfg}: ${p.passed}/${p.total} passed${p.errors ? `, ${p.errors} error(s)` : ""}, score ${pct(p.score)}${p.avgLatencyMs != null ? `, avg ${p.avgLatencyMs} ms` : ""}${p.tokens ? `, ${p.tokens} tokens` : ""}`); }
  const failures = sum.results.filter((r) => !r.pass);
  if (failures.length) {
    out.push("", "FAILURES");
    for (const r of failures) { out.push(`  ${r.config} / ${r.case}${r.error ? `  error: ${r.error}` : ""}`); for (const a of r.assertions.filter((x) => !x.pass)) out.push(`    x ${a.name ?? a.type}: ${a.detail}`); if (!r.error) out.push(`    output: ${short(r.output)}`); }
  }
  if (sum.regressions.length) { out.push("", `REGRESSIONS (${sum.regressions.length})`); for (const g of sum.regressions) out.push(`  ${g.case}: ${g.from} pass -> ${g.to} FAIL  (${short(g.detail, 120)})`); }
  if (sum.improvements.length) { out.push("", `IMPROVEMENTS (${sum.improvements.length})`); for (const g of sum.improvements) out.push(`  ${g.case}: ${g.from} fail -> ${g.to} pass`); }
  if (cmp) {
    out.push("", `VS BASELINE (${cmp.baselineAt?.slice(0, 16).replace("T", " ") ?? "?"})`);
    out.push(`  regressions ${cmp.regressions.length}, fixes ${cmp.fixes.length}, new ${cmp.added.length}, removed ${cmp.removed}`);
    for (const g of cmp.regressions) out.push(`  x ${g.config} / ${g.case}: ${short(g.detail, 120)}`);
  }
  return out.join("\n") + "\n";
}

export function markdown(sum, cmp) {
  const cases = [...new Set(sum.results.map((r) => r.case))];
  const cell = (cfg, c) => { const r = sum.results.find((x) => x.config === cfg && x.case === c); return r ? r.error ? "💥" : r.pass ? "✅" : "❌" : "–"; };
  const md = (s) => String(s).replace(/[&<>|`\r\n]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "|": "&#124;", "`": "&#96;", "\r": " ", "\n": " " }[c]));
  const out = [`## ai-regress: ${md(sum.suite)}`, "", `| case | ${sum.configs.join(" | ")} |`, `|---|${sum.configs.map(() => "---").join("|")}|`, ...cases.map((c) => `| \`${md(c)}\` | ${sum.configs.map((cfg) => cell(cfg, c)).join(" | ")} |`), ""];
  if (sum.results.some(r => r.cached)) out.push("Cached responses included; latency and tokens are original measurements.", "");
  out.push(sum.configs.map((cfg) => { const p = sum.perConfig[cfg]; return `**${cfg}**: ${p.passed}/${p.total} (${pct(p.score)})`; }).join(" · "));
  if (sum.regressions.length) { out.push("", `### ⚠️ ${sum.regressions.length} regression(s)`, ...sum.regressions.map((g) => `- \`${md(g.case)}\`: ${g.from} → ${g.to} — ${md(short(g.detail, 160))}`)); }
  if (cmp?.regressions.length) { out.push("", `### ⚠️ ${cmp.regressions.length} regression(s) vs baseline`, ...cmp.regressions.map((g) => `- \`${g.config}\` / \`${md(g.case)}\`: ${md(short(g.detail, 160))}`)); }
  const failures = sum.results.filter((r) => !r.pass);
  if (failures.length) { out.push("", "<details><summary>Failures</summary>", ""); for (const r of failures) out.push(`- **${r.config} / ${md(r.case)}** ${r.error ? `error: ${md(short(r.error))}` : r.assertions.filter((a) => !a.pass).map((a) => `${a.type}: ${md(a.detail)}`).join("; ")}`); out.push("", "</details>"); }
  return out.join("\n") + "\n";
}

/** JUnit XML: one testsuite per config, one testcase per case. */
export function junit(sum) {
  const suites = sum.configs.map((cfg) => {
    const rs = sum.results.filter((r) => r.config === cfg);
    const cases = rs.map((r) => {
      const body = r.error ? `<error message="${esc(short(r.error, 200))}"/>` : r.pass ? "" : `<failure message="${esc(r.assertions.filter((a) => !a.pass).map((a) => `${a.type}: ${a.detail}`).join("; "))}"><![CDATA[${xmlText(r.output).slice(0, 4000).replace(/]]>/g, "]]]]><![CDATA[>")}]]></failure>`;
      return `    <testcase classname="${esc(sum.suite)}.${esc(cfg)}" name="${esc(r.case)}" time="${((r.latencyMs ?? 0) / 1000).toFixed(3)}">${body}</testcase>`;
    });
    return `  <testsuite name="${esc(cfg)}" tests="${rs.length}" failures="${rs.filter((r) => !r.pass && !r.error).length}" errors="${rs.filter((r) => r.error).length}" timestamp="${esc(sum.at)}">\n${cases.join("\n")}\n  </testsuite>`;
  });
  return `<?xml version="1.0" encoding="UTF-8"?>\n<testsuites name="${esc(sum.suite)}">\n${suites.join("\n")}\n</testsuites>\n`;
}

export const json = (sum, cmp) => JSON.stringify(cmp ? { ...sum, baseline: cmp } : sum, null, 2) + "\n";
