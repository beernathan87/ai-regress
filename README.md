# ai-regress

Unit and regression tests for AI behaviour. Describe cases in YAML, point them at two (or more) prompt/model configurations, and get a table of what passed, what failed, and what **regressed** between versions - with a CI exit code and JUnit output. "GitHub Actions for AI behaviour."

```bash
npx ai-regress run tests.yml --config v1 --config v2

support-bot  (2026-09-13 07:10 UTC)

case      v1        v2
greeting  pass      pass
refund    pass      FAIL
json      pass      FAIL

v1: 3/3 passed, score 100%, avg 412 ms, 45 tokens
v2: 1/3 passed, score 56%, avg 398 ms, 40 tokens

REGRESSIONS (2)
  refund: v1 pass -> v2 FAIL  (not_contains: found forbidden "guarantee a refund"; judge: it promises a refund)
  json: v1 pass -> v2 FAIL  (json: missing key "problem")
```

Exit code 1 on failures/regressions (`--fail-on regressions` to only fail on regressions, `--fail-on none` to just report). Successful responses are cached on disk by content hash. Cache hits avoid provider calls; `--baseline` compares the new run with a saved report and does not itself prevent new calls.

## Suite file

```yaml
name: support-bot
judge: judge                  # optional: which config answers `judge:` assertions
defaults: { timeout: 60, retries: 1, concurrency: 4 }

configs:
  v1: { provider: openai, model: gpt-4o-mini, temperature: 0, system: "You are Acme support. Never promise refunds." }
  v2: { provider: openai, model: gpt-4o-mini, system_file: prompts/v2.md }
  claude: { provider: anthropic, model: claude-sonnet-5, system: "..." }
  local: { provider: openai, base_url: http://localhost:11434/v1, model: llama3.1 }   # Ollama / LM Studio / vLLM / OpenRouter
  agent: { provider: command, command: "node ./agent.js" }                           # any CLI/agent: JSON in, text out
  judge: { provider: openai, model: gpt-4o-mini }

cases:
  - id: refund-policy
    input: "I want a refund for order {{order}}"
    vars: { order: A-1234 }
    tags: [policy]
    assert:
      - not_contains: ["guarantee a refund"]
      - icontains: "A-1234"
      - max_words: 120
      - judge: "Does the answer stay helpful without promising a refund?"
  - id: extract
    messages: [{ role: user, content: "Return JSON with keys order and problem for: 'B-77 came without charger'" }]
    assert:
      - json: { order: string, problem: string }
      - json_path: [order, "B-77"]
```

Full example: `examples/support-bot.yml`. `ai-regress validate tests.yml` checks the file without calling anything.

### Assertions

Deterministic: `contains` / `icontains` / `not_contains` (string or list), `regex` / `not_regex`, `equals` / `iequals`, `starts_with` / `ends_with`, `one_of`, `min_length` / `max_length`, `min_words` / `max_words`, `not_empty`, `no_refusal` (common refusal phrases), `json` (`true`, or a shape `{ key: string|number|boolean|array|object|any, optional?: "string?" }` - fenced or embedded JSON is extracted), `json_keys` (dotted paths), `json_path` (`[path, expected]`), `similar_to` (token Jaccard, `{ text, min }`), `latency_ms`.

LLM judge: `judge: "<yes/no question>"` asks the `judge` config for `{"pass": bool, "reason"}` with the case input and output; the reason lands in the report. Use it only where a deterministic check cannot express the requirement - judges are cached like everything else.

Each assertion takes an optional `weight` (default 1) and `name`; a case's `score` is the weighted pass ratio, `pass` needs every assertion, even assertions with weight 0. Weights must be finite and nonnegative; if all weights are zero, score is 1 for a passing case and 0 otherwise.

### Providers

| provider | needs | notes |
|---|---|---|
| `openai` | `OPENAI_API_KEY` (or `api_key_env`) | any OpenAI-compatible `/chat/completions`: set `base_url` |
| `anthropic` | `ANTHROPIC_API_KEY` | Messages API |
| `command` | a shell command | receives `{system, messages, vars}` JSON on stdin, returns the answer on stdout |
| `mock` | nothing | `responses:` string, `{ "<input>": "<answer>", "*": "<default>" }`, or `[ { match: regex, text } ]` - for testing the harness itself |

Per-config: `temperature`, `max_tokens`, `headers`, `extra` (merged into the request body). Per-case: `configs: [v1]` restricts a case to some configs; `--tag` / `--filter` select cases at run time.

## Before / after

Two ways:

1. **Across configs in one run** - `--config old --config new`: a case that passes on the first config and fails on a later one is a regression.
2. **Across time** - `--save results.json` on main, later `--baseline results.json`: pass → fail for the same (config, case) is a regression; fail → pass is a fix. Combine with `--fail-on regressions` so pre-existing failures don't block CI.

## CI

```yaml
- run: npx ai-regress run tests.yml --config prod --config candidate --junit report.xml --format markdown >> $GITHUB_STEP_SUMMARY
  env: { OPENAI_API_KEY: ${{ secrets.OPENAI_API_KEY }} }
```

Cache the `.ai-regress-cache/` directory between runs to reuse unchanged requests. Add it to your own `.gitignore` (this repo already does). Cache files contain only output text, original latency, usage and timestamp, never request bodies or header values. Outputs and saved reports can still contain sensitive text.

### v0.1 execution contract

- Provider/judge errors fail the case with score 0 and count as regressions if the comparison previously passed. Summary `failed` counts assertion failures; `errors` is separate. Default CI failure count includes both.
- Config comparisons are **first-vs-each**, not adjacent or all-pairs. Repeated `--config` values are deduplicated in first-occurrence order. A single config produces no cross-config regressions. Per-case restrictions can leave pairs incomparable.
- Baselines require the same suite name and at least one identical `(config, case)` pair. Renamed configs/cases are added/removed, not automatically matched; zero overlap, malformed records and duplicate pairs are errors. `--baseline` and `--save` may share a path: comparison reads before saving.
- `retries: 1` means at most two attempts per provider call. Network/timeout failures and HTTP 408/429/5xx retry with 200 ms exponential backoff capped at 2 seconds; other HTTP errors do not retry. Timeout is per attempt. Native fetch honors AbortSignal; custom fetch implementations must honor it too.
- Concurrency is a positive safe integer, retries a nonnegative safe integer, timeout positive and at most 2147483 seconds. Empty run selections, unknown keys/flags, unknown restricted configs and unsupported message content are errors (exit 2). Progress marks appear only on stderr TTY with text output. Exit 1 means the selected failure policy was triggered; `--fail-on none` does not suppress usage errors.
- YAML uses 1.2 semantics: `yes` and `on` are strings, `true` and `false` are booleans. `assert: "text"` means `contains: "text"`. Message content is text-only; input content arrays are rejected. OpenAI response text arrays are joined; malformed/textless API responses fail the case.
- `contains` is case-sensitive; `icontains` and `not_contains` are case-insensitive. Regexes use JavaScript syntax with dotAll and run in-process: only use trusted patterns/suites (pathological patterns can block the event loop). `similar_to` uses Unicode letter/number runs, without CJK word segmentation, so unspaced CJK comparisons can be coarse. JSON shapes are flat type maps, not recursive schemas; use dotted `json_keys`/`json_path` checks for nested values. Invalid/nested type shapes are rejected.
- `no_refusal` is an English phrase heuristic, not a semantic classifier. Sympathy and benign apologies are accepted, but quoted refusal phrases can still trigger it. Judge input/output is JSON-delimited untrusted data with explicit evaluation instructions; this reduces, but cannot eliminate, prompt injection or judge mistakes. A string verdict such as `"pass": "true"` fails.
- Cache identity hashes the complete normalized config except its display name, messages, vars, effective environment-selected endpoint and API credential; provider, system prompt, temperature, headers and `extra` are included. Command working directory is included. Secret values participate only in the hash, not the cache record. Invalid records are misses. Writes use unique temporary files and atomic replacement; simultaneous identical misses may make duplicate calls and the last complete response wins.
- Cached latency assertions use the **original request latency**, explicitly labeled in assertion details. Text/Markdown reports label cached measurements; JSON exposes `cached`, and JUnit times also retain original latency. Tokens are original response usage (excluding judge calls), not newly billed tokens. Use `--no-cache` for fresh latency/behavior measurements, changed command scripts/environment or mutable model aliases; external changes cannot be inferred from a config hash.

For newer OpenAI Chat Completions models, use `extra: { max_completion_tokens: 1024 }`; it replaces the legacy `max_tokens` field. Set `temperature: null` (or `extra: { temperature: null }`) to omit temperature on models that reject it. `extra.response_format` is passed through. Choose fields supported by your model; streaming/tool-only output is outside this text tester's scope. See the [official OpenAI Chat API reference](https://developers.openai.com/api/reference/resources/chat).

Anthropic instructions go in top-level `system`: config.system and leading case system messages are joined. This adapter requires the remaining conversation to start with a user and contain user/assistant turns; later system/developer messages are explicitly unsupported rather than silently discarded. Model-specific assistant-prefill restrictions still apply. See the [official Anthropic Messages reference](https://platform.claude.com/docs/en/api/messages/create).

The command provider executes a trusted shell string in the current directory (`cmd.exe` on Windows; quote executable/script paths with spaces using shell syntax). Request text goes only through JSON stdin, not shell interpolation. Stdout must be UTF-8 and at most 4 MiB; overflow, invalid encoding and nonzero exits fail instead of truncating an answer. Timeout/overflow terminates the process tree on Windows or process group on POSIX; deliberately detached grandchildren are not guaranteed to terminate. Stderr diagnostics are bounded.

## Not in v1 (on purpose)

Statistical repeats/variance, cost tracking per provider price, tool-call/agent-trajectory assertions, a web UI, hosted history. Hosted history and a dashboard are the intended paid layer.

MIT.
