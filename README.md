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

Exit code 1 on failures/regressions (`--fail-on regressions` to only fail on regressions, `--fail-on none` to just report). Responses are cached on disk by content hash, so re-runs are free and `--baseline` comparisons don't re-bill.

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

Each assertion takes an optional `weight` (default 1) and `name`; a case's `score` is the weighted pass ratio, `pass` needs every assertion.

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

Cache the `.ai-regress-cache/` directory between runs to avoid re-billing unchanged cases.

## Not in v1 (on purpose)

Statistical repeats/variance, cost tracking per provider price, tool-call/agent-trajectory assertions, a web UI, hosted history. Hosted history and a dashboard are the intended paid layer.

MIT.
