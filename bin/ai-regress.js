#!/usr/bin/env node
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { loadSuite } from "../src/suite.js";
import { runSuite, compareBaseline } from "../src/run.js";
import * as report from "../src/report.js";

const HELP = `ai-regress - regression tests for AI behaviour

Usage
  ai-regress run <suite.yml> [--config v1 --config v2] [--baseline results.json] [--save results.json]
                             [--format text|markdown|json|junit] [--junit report.xml] [--filter ID] [--tag T]
                             [--no-cache] [--cache-dir DIR] [--fail-on any|regressions|none]
  ai-regress validate <suite.yml>

--config       configs to run, in order (default: all). With two or more, the first is the baseline for
               "regressions" (pass in the first config, fail in a later one).
--baseline     compare with a previous --save file: pass -> fail per (config, case) is a regression.
--fail-on      any (default): exit 1 on any failure · regressions: only on regressions · none: always 0
Exit codes: 0 ok · 1 failures/regressions · 2 usage or suite error`;

const args = process.argv.slice(2);
const flags = (name) => { const out = []; for (let i; (i = args.indexOf(name)) !== -1;) { const v = args[i + 1]; if (v === undefined || v.startsWith("--")) throw new Error(`${name} needs a value`); out.push(v); args.splice(i, 2); } return out; };
const flag = (name, def) => { const v = flags(name); return v.length ? v[v.length - 1] : def; };
const bool = (name) => { const i = args.indexOf(name); if (i === -1) return false; args.splice(i, 1); return true; };
try {
  if (args.includes("--help") || args.includes("-h") || !args.length) { console.log(HELP); process.exit(args.length ? 0 : 2); }
  if (args.length === 1 && ["--version", "-v"].includes(args[0])) { console.log(JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version); process.exit(0); }
  const cmd = args.shift();
  if (!["run", "validate"].includes(cmd)) throw new Error(`unknown command ${cmd}`);
  const configs = flags("--config"), baselineFile = flag("--baseline"), save = flag("--save"), format = flag("--format", "text"), junitFile = flag("--junit"), filter = flag("--filter", null), tags = flags("--tag");
  const noCache = bool("--no-cache"), cacheDir = flag("--cache-dir", ".ai-regress-cache"), failOn = flag("--fail-on", "any");
  if (args.length !== 1 || args[0].startsWith("-")) throw new Error(`expected one suite file; unexpected arguments: ${args.join(" ")}`);
  const file = args[0];
  if (!file) throw new Error("suite file required"); if (!existsSync(file)) throw new Error(`no such file: ${file}`);
  if (!report[format]) throw new Error(`unknown format ${format}`); if (!["any", "regressions", "none"].includes(failOn)) throw new Error("--fail-on any|regressions|none");
  const suite = loadSuite(file);
  if (cmd === "validate") { console.log(`${file}: ok - ${Object.keys(suite.configs).length} config(s), ${suite.cases.length} case(s), ${suite.cases.reduce((s, c) => s + c.asserts.length, 0)} assertion(s)${suite.judge ? `, judge ${suite.judge}` : ""}`); process.exit(0); }
  const tty = process.stderr.isTTY && format === "text";
  const sum = await runSuite(suite, { configs: configs.length ? configs : undefined, cache: !noCache, cacheDir, filter, tags, onResult: (r) => { if (tty) process.stderr.write(`${r.error ? "E" : r.pass ? "." : "F"}`); } });
  if (tty) process.stderr.write("\n");
  const cmp = baselineFile ? compareBaseline(sum, JSON.parse(readFileSync(baselineFile, "utf8"))) : null;
  process.stdout.write(report[format](sum, cmp));
  if (save) writeFileSync(save, report.json(sum));
  if (junitFile) writeFileSync(junitFile, report.junit(sum));
  const failures = sum.results.filter((r) => !r.pass).length, regressions = sum.regressions.length + (cmp?.regressions.length ?? 0);
  process.exit(failOn === "none" ? 0 : failOn === "regressions" ? (regressions ? 1 : 0) : (failures || regressions ? 1 : 0));
} catch (e) { console.error(`ai-regress: ${e.message}`); process.exit(2); }
