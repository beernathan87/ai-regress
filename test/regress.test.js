import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, writeFileSync, rmSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { validateSuite, loadSuite, render } from "../src/suite.js";
import { evaluate, similarity, judge } from "../src/assert.js";
import { complete } from "../src/providers.js";
import { runSuite, compareBaseline } from "../src/run.js";
import * as report from "../src/report.js";

// Fake model API: answers depend on the system prompt ("v1"/"v2") so two configs behave differently.
let server, base, calls = 0;
before(async () => {
  server = createServer((req, res) => {
    let body = ""; req.on("data", (d) => (body += d));
    req.on("end", () => {
      calls++;
      const j = JSON.parse(body);
      if (req.url === "/v1/chat/completions") {
        if (req.headers.authorization !== "Bearer test-key") { res.writeHead(401); res.end('{"error":"bad key"}'); return; }
        const sys = j.messages.find((m) => m.role === "system")?.content ?? "", user = j.messages.at(-1).content;
        let text = `Hello! ${user}`;
        if (/refund/i.test(user)) text = sys.includes("v2") ? "I guarantee a refund right away for order A-1234." : "Sorry about order A-1234! Let me check what we can do.";
        if (/JSON/i.test(user)) text = sys.includes("v2") ? "```json\n{\"order\":\"B-77\"}\n```" : "{\"order\":\"B-77\",\"problem\":\"missing charger\"}";
        if (/evaluator/i.test(user)) text = /guarantee a refund/.test(user) ? '{"pass": false, "reason": "it promises a refund"}' : '{"pass": true, "reason": "helpful and no promise"}';
        res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ choices: [{ message: { content: text } }], usage: { prompt_tokens: 10, completion_tokens: 5 } }));
      } else if (req.url === "/v1/messages") {
        if (req.headers["x-api-key"] !== "ant-key") { res.writeHead(401); res.end("{}"); return; }
        res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ content: [{ type: "text", text: `Claude says: ${j.messages.at(-1).content} (${j.system ?? "no system"})` }], usage: { input_tokens: 3, output_tokens: 4 } }));
      } else { res.writeHead(404); res.end(); }
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

const SUITE = () => ({
  name: "support-bot", judge: "judge",
  defaults: { timeout: 5, retries: 0, concurrency: 3 },
  configs: {
    v1: { provider: "openai", model: "fake", base_url: base + "/v1", system: "prompt v1: never promise refunds" },
    v2: { provider: "openai", model: "fake", base_url: base + "/v1", system: "prompt v2: be generous" },
    judge: { provider: "openai", model: "fake", base_url: base + "/v1" },
  },
  cases: [
    { id: "greeting", input: "hi", assert: [{ icontains: ["hello"] }, { max_words: 20 }, { no_refusal: true }, { latency_ms: 5000 }] },
    { id: "refund", input: "refund for order {{order}}", vars: { order: "A-1234" }, tags: ["policy"], assert: [{ not_contains: ["guarantee a refund"] }, { contains: "A-1234" }, { judge: "Does it avoid promising a refund?" }] },
    { id: "json", input: "Answer as JSON", assert: [{ json: { order: "string", problem: "string" } }, { json_path: ["order", "B-77"] }] },
  ],
});
const ENV = { OPENAI_API_KEY: "test-key", ANTHROPIC_API_KEY: "ant-key" };

test("first milestone: run a suite against two prompt versions and report regressions", async () => {
  const suite = validateSuite(SUITE());
  const dir = mkdtempSync(join(tmpdir(), "air-"));
  try {
    const before = calls;
    const sum = await runSuite(suite, { configs: ["v1", "v2"], cacheDir: dir, env: ENV });
    assert.equal(sum.perConfig.v1.passed, 3); assert.equal(sum.perConfig.v2.passed, 1);
    assert.deepEqual(sum.regressions.map((r) => `${r.case}:${r.to}`), ["refund:v2", "json:v2"]);
    const refund = sum.results.find((r) => r.config === "v2" && r.case === "refund");
    assert.deepEqual(refund.assertions.map((a) => a.pass), [false, true, false]);
    assert.match(refund.assertions[2].detail, /judge: it promises a refund/);
    const jsonV2 = sum.results.find((r) => r.config === "v2" && r.case === "json");
    assert.match(jsonV2.assertions[0].detail, /missing key "problem"/); assert.equal(jsonV2.assertions[1].pass, true, "fenced JSON is parsed");
    assert.equal(sum.perConfig.v1.tokens, 45, "judge tokens count for the case's config"); assert.ok(sum.perConfig.v1.avgLatencyMs >= 0);
    const made = calls - before;
    // cache: a second run makes no calls
    const again = await runSuite(suite, { configs: ["v1", "v2"], cacheDir: dir, env: ENV });
    assert.equal(calls - before, made); assert.ok(again.results.every((r) => r.cached));
    // baseline comparison: v2 fixed vs previous run where it failed
    const fixedSuite = validateSuite({ ...SUITE(), configs: { ...SUITE().configs, v2: SUITE().configs.v1 } });
    const now = await runSuite(fixedSuite, { configs: ["v1", "v2"], cacheDir: dir, env: ENV });
    const cmp = compareBaseline(now, sum);
    assert.equal(cmp.regressions.length, 0); assert.deepEqual(cmp.fixes.map((f) => f.case), ["refund", "json"]);
    const cmp2 = compareBaseline(sum, now);
    assert.equal(cmp2.regressions.length, 2);
    // reports
    const t = report.text(sum, cmp2);
    assert.match(t, /refund\s+pass\s+FAIL/); assert.match(t, /REGRESSIONS \(2\)/); assert.match(t, /v1: 3\/3 passed/); assert.match(t, /VS BASELINE/);
    const m = report.markdown(sum); assert.match(m, /\| `refund` \| ✅ \| ❌ \|/); assert.match(m, /2 regression\(s\)/);
    const x = report.junit(sum); assert.match(x, /<testsuite name="v2" tests="3" failures="2"/); assert.match(x, /<failure message="not_contains: found forbidden/);
    const j = JSON.parse(report.json(sum)); assert.equal(j.regressions.length, 2);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("assertions: every deterministic type, similarity, refusal detection, json shapes", () => {
  const ev = (type, value, out, meta) => evaluate({ type, value }, out, meta).pass;
  assert.ok(ev("contains", ["a", "b"], "xa yb")); assert.ok(!ev("contains", "z", "abc")); assert.ok(ev("icontains", "ABC", "xabcx"));
  assert.ok(ev("not_contains", ["sorry"], "fine")); assert.ok(!ev("not_contains", "Sorry", "so sorry"));
  assert.ok(ev("regex", "^h.llo", "hello")); assert.ok(ev("not_regex", "\\d", "none")); assert.ok(ev("equals", " x ", "x")); assert.ok(ev("iequals", "YES", "yes\n"));
  assert.ok(ev("starts_with", "Dear", "  Dear Sir")); assert.ok(ev("ends_with", "bye", "ok bye\n")); assert.ok(ev("one_of", ["yes", "no"], "no"));
  assert.ok(ev("min_length", 3, "abc")); assert.ok(!ev("max_length", 2, "abc")); assert.ok(ev("max_words", 2, "a b")); assert.ok(!ev("min_words", 3, "a b"));
  assert.ok(!ev("not_empty", true, "  ")); assert.ok(!ev("no_refusal", true, "I'm sorry, but I cannot help with that")); assert.ok(ev("no_refusal", true, "Sure, here it is"));
  assert.ok(ev("json", true, "```json\n{\"a\":1}\n```")); assert.ok(!ev("json", true, "not json")); assert.ok(ev("json", { a: "number", b: "string?" }, '{"a":1}')); assert.ok(!ev("json", { a: "number" }, '{"a":"1"}'));
  assert.ok(ev("json_keys", ["user.name"], '{"user":{"name":"x"}}')); assert.ok(ev("json_path", { path: "a.b", equals: [1, 2] }, 'prefix {"a":{"b":[1,2]}} suffix'));
  assert.ok(ev("similar_to", { text: "the cat sat on the mat", min: 0.5 }, "the cat sat on a mat")); assert.equal(similarity("a b c", "a b c"), 1); assert.equal(similarity("", ""), 1);
  assert.ok(ev("latency_ms", 100, "x", { latencyMs: 50 })); assert.ok(!ev("latency_ms", 10, "x", { latencyMs: 50 }));
  assert.equal(evaluate({ type: "nope" }, "x").pass, false);
});

test("judge parsing is robust; providers: anthropic, mock, command, errors, retries stop on hard errors", async () => {
  let j = await judge("q", "out", "in", async () => 'Sure! ```json\n{"pass": true, "reason": "fine"}\n```'); assert.equal(j.pass, true);
  j = await judge("q", "out", "in", async () => "I think yes"); assert.equal(j.pass, false); assert.match(j.detail, /did not return/);
  const ant = await complete({ provider: "anthropic", model: "c", base_url: base, system: "sys {{x}}", headers: {}, extra: {}, max_tokens: 10, temperature: 0 }, [{ role: "user", content: "hi {{x}}" }], { x: "1" }, { env: ENV });
  assert.equal(ant.text, "Claude says: hi 1 (sys 1)"); assert.deepEqual(ant.usage, { input: 3, output: 4 });
  await assert.rejects(complete({ provider: "anthropic", model: "c", base_url: base, headers: {}, extra: {} }, [{ role: "user", content: "x" }], {}, { env: {} }), /missing API key: set ANTHROPIC_API_KEY/);
  await assert.rejects(complete({ provider: "openai", model: "c", base_url: base + "/v1", headers: {}, extra: {} }, [{ role: "user", content: "x" }], {}, { env: { OPENAI_API_KEY: "wrong" } }), /openai 401/);
  const mock = await complete({ provider: "mock", responses: [{ match: "^hi", text: "hey" }, { text: "default" }] }, [{ role: "user", content: "hi there" }], {}, {});
  assert.equal(mock.text, "hey");
  assert.equal((await complete({ provider: "mock", responses: { "*": "star" } }, [{ role: "user", content: "zzz" }], {}, {})).text, "star");
  const cmd = await complete({ provider: "command", command: `${JSON.stringify(process.execPath)} -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const j=JSON.parse(s);console.log('echo:'+j.messages[0].content+':'+j.system)})"`, system: "S", headers: {}, extra: {} }, [{ role: "user", content: "ping" }], {}, { timeout: 10 });
  assert.equal(cmd.text, "echo:ping:S");
  await assert.rejects(complete({ provider: "command", command: `${JSON.stringify(process.execPath)} -e "process.exit(3)"`, headers: {}, extra: {} }, [{ role: "user", content: "x" }], {}, { timeout: 10 }), /exited 3/);
  assert.equal(render("a {{ b }} {{c}}", { b: 1 }), "a 1 {{c}}");
});

test("suite validation errors are readable; filters and per-case config restriction", async () => {
  assert.throws(() => validateSuite({ cases: [] }), /configs/);
  assert.throws(() => validateSuite({ configs: { a: { provider: "nope" } }, cases: [] }), /provider/);
  assert.throws(() => validateSuite({ configs: { a: { provider: "openai" } }, cases: [] }), /model: required/);
  assert.throws(() => validateSuite({ configs: { a: { provider: "mock" } }, cases: [{ id: "x", input: "a", assert: [{ bogus: 1 }] }] }), /exactly one of/);
  assert.throws(() => validateSuite({ configs: { a: { provider: "mock" } }, cases: [{ id: "x", input: "a", assert: ["a"] }, { id: "x", input: "b", assert: ["b"] }] }), /duplicate/);
  assert.throws(() => validateSuite({ configs: { a: { provider: "mock" } }, judge: "zz", cases: [{ input: "a", assert: ["a"] }] }), /judge/);
  const s = validateSuite({ configs: { a: { provider: "mock", responses: "AAA" }, b: { provider: "mock", responses: "BBB" } }, cases: [{ id: "one", input: "x", tags: ["t"], assert: ["AAA"] }, { id: "two", input: "y", configs: ["a"], assert: [{ regex: "A+" }] }, { id: "three", input: "z", assert: ["ZZZ"] }] });
  const sum = await runSuite(s, { cache: false, tags: ["t"] });
  assert.deepEqual(sum.results.map((r) => `${r.config}/${r.case}`), ["a/one", "b/one"]);
  const all = await runSuite(s, { cache: false });
  assert.deepEqual(all.results.map((r) => `${r.config}/${r.case}:${r.pass}`), ["a/one:true", "a/two:true", "a/three:false", "b/one:false", "b/three:false"]);
  assert.equal(all.regressions.length, 1); assert.equal(all.regressions[0].case, "one");
  const f = await runSuite(s, { cache: false, filter: "thr" }); assert.equal(f.results.length, 2);
});

test("CLI: validate, run with two configs, --save/--baseline, junit file, exit codes, fail-on", () => {
  const bin = join(import.meta.dirname, "..", "bin", "ai-regress.js");
  const dir = mkdtempSync(join(tmpdir(), "air-cli-"));
  const run = (a, opts = {}) => { try { return { code: 0, out: execFileSync(process.execPath, [bin, ...a], { cwd: dir, encoding: "utf8", env: { ...process.env, ...ENV }, stdio: ["pipe", "pipe", "pipe"] }) }; } catch (e) { return { code: e.status, out: (e.stdout ?? "") + (e.stderr ?? "") }; } };
  try {
    mkdirSync(join(dir, "prompts"));
    writeFileSync(join(dir, "prompts/v2.md"), "prompt v2: be generous");
    // execFileSync blocks this process, so the CLI test uses mock providers instead of the in-process fake server
    const mockFor = (v2) => ({ provider: "mock", system_file: "prompts/v2.md", responses: [{ match: "^hi", text: "Hello!" }, { match: "refund", text: v2 ? "I guarantee a refund for A-1234" : "Sorry about A-1234, let me check" }, { match: "JSON", text: v2 ? '{"order":"B-77"}' : '{"order":"B-77","problem":"x"}' }, { match: "evaluator", text: v2 ? '{"pass":false,"reason":"promises"}' : '{"pass":true,"reason":"ok"}' }] });
    const suite = SUITE(); suite.configs = { v1: mockFor(false), v2: mockFor(true), judge: { provider: "mock", responses: { "*": '{"pass":true,"reason":"ok"}' } } };
    writeFileSync(join(dir, "suite.json"), JSON.stringify(suite));
    let r = run(["validate", "suite.json"]); assert.equal(r.code, 0, r.out); assert.match(r.out, /3 config\(s\), 3 case\(s\), 9 assertion\(s\), judge judge/);
    r = run(["run", "suite.json", "--config", "v1"]); assert.equal(r.code, 0, r.out); assert.match(r.out, /v1: 3\/3 passed/);
    r = run(["run", "suite.json", "--config", "v1", "--config", "v2", "--save", "base.json", "--junit", "out.xml", "--format", "markdown"]);
    assert.equal(r.code, 1); assert.match(r.out, /2 regression\(s\)/); assert.ok(existsSync(join(dir, "out.xml"))); assert.match(readFileSync(join(dir, "out.xml"), "utf8"), /<testsuites/);
    r = run(["run", "suite.json", "--config", "v1", "--config", "v2", "--fail-on", "none"]); assert.equal(r.code, 0);
    r = run(["run", "suite.json", "--config", "v2", "--baseline", "base.json", "--fail-on", "regressions"]); assert.equal(r.code, 0, "same failures as baseline are not regressions"); assert.match(r.out, /regressions 0, fixes 0/);
    r = run(["run", "suite.json", "--config", "v1", "--baseline", "base.json", "--filter", "greeting", "--format", "json"]); assert.equal(r.code, 0); assert.equal(JSON.parse(r.out).baseline.regressions.length, 0);
    r = run(["run", "suite.json", "--config", "nope"]); assert.equal(r.code, 2); assert.match(r.out, /unknown config/);
    r = run(["run", "missing.yml"]); assert.equal(r.code, 2);
    assert.ok(existsSync(join(dir, ".ai-regress-cache")));
    const yml = loadSuite(join(import.meta.dirname, "..", "examples", "support-bot.yml")); assert.equal(yml.cases.length, 4);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("expected_failure: a failing case passes (xfail), an unexpected pass fails, provider errors stay errors", async () => {
  const { loadSuite } = await import("../src/suite.js"); const { runSuite } = await import("../src/run.js");
  const { writeFileSync, mkdtempSync, rmSync } = await import("node:fs"); const { tmpdir } = await import("node:os"); const { join } = await import("node:path");
  const dir = mkdtempSync(join(tmpdir(), "ar-xf-")); const file = join(dir, "s.yml");
  writeFileSync(file, `name: xf
configs:
  ok: { provider: mock, responses: "hello world" }
  broken: { provider: command, command: 'node -e "process.exit(3)"' }
cases:
  - id: known-bug
    input: hi
    expected_failure: true
    assert: [{ contains: "goodbye" }]
  - id: fixed-now
    input: hi
    expected_failure: true
    assert: [{ contains: "hello" }]
  - id: normal
    input: hi
    assert: [{ contains: "hello" }]
`);
  try {
    const suite = loadSuite(file);
    const sum = await runSuite(suite, { configs: ["ok"], cache: false });
    const by = Object.fromEntries(sum.results.map((r) => [r.case, r]));
    assert.equal(by["known-bug"].pass, true); assert.equal(by["known-bug"].expectedFailure, true); assert.equal(by["known-bug"].score, 1);
    assert.equal(by["fixed-now"].pass, false); assert.match(by["fixed-now"].assertions.at(-1).detail, /expected to fail/);
    assert.equal(by["normal"].pass, true);
    assert.equal(sum.perConfig.ok.passed, 2); assert.equal(sum.perConfig.ok.failed, 1);
    const err = await runSuite(suite, { configs: ["broken"], cache: false });
    assert.equal(err.perConfig.broken.errors, 3);
    assert.throws(() => loadSuite((writeFileSync(file, "name: x\nconfigs: { a: { provider: mock, responses: x } }\ncases: [{ id: a, input: a, expected_failure: yes, assert: [{ contains: a }] }]"), file)), /expected_failure/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("production: empty expectations are rejected; provider error bodies never echo the API key; explicit api_key_env must exist", async () => {
  const { loadSuite } = await import("../src/suite.js"); const { complete } = await import("../src/providers.js");
  const { writeFileSync, mkdtempSync, rmSync } = await import("node:fs"); const { tmpdir } = await import("node:os"); const { join } = await import("node:path");
  const dir = mkdtempSync(join(tmpdir(), "ar-val-")); const file = join(dir, "s.yml");
  try {
    for (const bad of ['{ contains: "" }', '{ icontains: "  " }', '{ not_contains: ["x", ""] }', '{ regex: "" }', '{ one_of: [""] }', '{ judge: "" }']) {
      writeFileSync(file, `name: x\nconfigs: { a: { provider: mock, responses: x } }\ncases: [{ id: a, input: a, assert: [${bad}] }]`);
      assert.throws(() => loadSuite(file), /non-empty string/, bad);
    }
    const srv = (await import("node:http")).createServer((req, res) => { res.writeHead(401, { "content-type": "application/json" }); res.end(JSON.stringify({ error: `bad key ${req.headers.authorization}` })); });
    await new Promise((r) => srv.listen(0, "127.0.0.1", r));
    const url = `http://127.0.0.1:${srv.address().port}/v1`;
    const msgs = [{ role: "user", content: "hi" }];
    await assert.rejects(() => complete({ provider: "openai", model: "m", base_url: url }, msgs, {}, { env: { OPENAI_API_KEY: "sk-secret-value-123" } }), (e) => /401/.test(e.message) && !e.message.includes("sk-secret-value-123") && e.message.includes("[redacted]"));
    await assert.rejects(() => complete({ provider: "openai", model: "m", base_url: url, api_key_env: "NOT_SET_ENV" }, msgs, {}, { env: {} }), /missing API key: set NOT_SET_ENV/);
    await assert.rejects(() => complete({ provider: "openai", model: "m", base_url: url }, msgs, {}, { env: {} }), /401/, "keyless local openai-compatible server is allowed (request is made, server answers 401)");
    srv.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
