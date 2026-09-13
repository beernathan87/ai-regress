# Changelog

## 0.1.0 (unreleased)

First release: YAML suites with prompt/model configs (OpenAI-compatible, Anthropic, shell command, mock), deterministic assertions plus an optional LLM judge, weighted scores, cross-config and cross-time (baseline) regression detection, text / Markdown / JSON / JUnit reports, content-hash response cache, retries with backoff, CI exit codes.

Production pass (2026-09-13): `expected_failure: true` (strict xfail) per case; empty expectations (`contains: ""` and friends) rejected at validation; provider error bodies redact the API key; an explicitly configured `api_key_env` must exist; `--version`; CI workflow (ubuntu + windows) with a packed-tarball install smoke; README sections for providers/versions, credentials, troubleshooting and the security boundary; changelog and notices shipped in the tarball.
