# AI Scam Detector — Implementation Tasks

**Version:** 1.0  
**Date:** June 6, 2026  
**Refs:** `technical-design.md` v1.0, `requirements.md` v1.0

---

## Reading This Document

**Effort scale** — estimates assume a senior engineer working full-time:
- `XS` = < 0.5 day
- `S` = 0.5–1 day
- `M` = 2–3 days
- `L` = 4–5 days
- `XL` = 1–2 weeks

**Dependencies** — listed as task IDs that must be completed before a task begins.  
**Owner** — suggested team: `BE` = Backend, `ML` = ML/AI, `Infra` = Infrastructure, `Full` = Both BE + Infra.

---

## Milestones at a Glance

| # | Milestone | Deliverable | Target |
|---|---|---|---|
| M1 | Foundation | Project scaffold, schemas, auth, CI skeleton | End of Week 1 |
| M2 | Core Pipeline (No ML) | Rule engine + URL checker + recommendations end-to-end | End of Week 3 |
| M3 | ML Integration | Fine-tuned model trained, served, integrated into pipeline | End of Week 6 |
| M4 | Production Ready | Observability, security hardening, load tested, deployed to staging | End of Week 8 |
| M5 | GA Launch | Production deployment, runbooks, monitoring dashboards live | End of Week 9 |

---

## Milestone 1 — Foundation

> Goal: runnable project skeleton with CI, auth, and validated API contract in place. Every subsequent task builds on this.

---

### T-01 · Project scaffold and repo structure

**Owner:** BE | **Effort:** S | **Depends on:** —

Set up the repository layout defined in `technical-design.md §14-A`.

- Create directory tree: `api/`, `pipeline/`, `models/`, `ml/`, `config/`, `tests/`, `k8s/`
- Initialize `pyproject.toml` with all pinned dependencies from `§14-B`
- Configure `ruff` for linting and `black` for formatting
- Add `.gitignore`, `README.md` skeleton, `CONTRIBUTING.md`
- Add `Makefile` with targets: `install`, `lint`, `test`, `run-dev`

**Done when:** `make install && make lint` passes on a clean checkout.

---

### T-02 · Pydantic request/response schemas

**Owner:** BE | **Effort:** S | **Depends on:** T-01

Implement `models/schemas.py` with all types from `technical-design.md §10`.

- `AnalyzeRequest` with field validation (min/max lengths, enum constraints)
- `SuspiciousPhrase` with the 9-tag literal union
- `AnalyzeResponse` with all fields, `analyzed_at` as `datetime`
- `ErrorResponse`
- Unit tests for schema validation edge cases (empty body, body at 10,000 chars, invalid channel enum, subject over RFC limit)

**Done when:** All schema unit tests pass; `mypy --strict` reports no errors on `models/`.

---

### T-03 · App settings and configuration layer

**Owner:** BE | **Effort:** S | **Depends on:** T-01

Implement `config/settings.py` using `pydantic-settings`.

- Settings loaded from environment variables with sensible defaults
- Groups: `ApiSettings` (host, port, workers), `RedisSettings`, `MLSettings` (model version, gRPC host/port, timeout), `UrlCheckerSettings` (GSB API key, PhishTank key, timeouts), `LlmSettings` (provider, model name, API key, timeout), `ScoreWeights` (w_ml, w_rule, w_url)
- All secrets read from env only; no defaults for key values
- Settings instance is a module-level singleton imported across the codebase

**Done when:** Settings load correctly from a `.env.example` file; missing required secrets raise a clear startup error.

---

### T-04 · FastAPI application entry point and health endpoint

**Owner:** BE | **Effort:** S | **Depends on:** T-02, T-03

Implement `api/main.py` and the application factory.

- FastAPI app with `lifespan` context manager for startup/shutdown hooks
- `GET /health` returns `{"status": "ok", "version": "..."}` — used by Kubernetes liveness probe
- `GET /ready` returns 200 only when Redis and ML server connections are healthy — used by readiness probe
- Global exception handlers mapping unhandled exceptions to `ErrorResponse` with HTTP 500
- `orjson` response class configured globally

**Done when:** `GET /health` returns 200; `GET /ready` returns 503 when Redis is not available.

---

### T-05 · Authentication middleware

**Owner:** BE | **Effort:** M | **Depends on:** T-03, T-04

Implement `api/middleware/auth.py` as a FastAPI dependency injected on the `/v1/analyze` route.

**API Key path:**
- Extract `Authorization: ApiKey <key>` header
- Compute `HMAC-SHA256(key)` and look up in Redis
- Cache the result for 5 minutes to reduce Redis round-trips
- Return HTTP 401 with `UNAUTHORIZED` error code on miss

**JWT path:**
- Extract `Authorization: Bearer <token>`
- Validate RS256 JWT: signature (against cached JWKS), `exp`, `iss`, `scope: scam-detector:analyze`
- Cache JWKS public keys in-memory for 1 hour; refresh on 401 from validation
- Return HTTP 401 on any validation failure

**Request ID injection:**
- Generate UUID v4; attach to request state as `request.state.request_id`
- Include in all downstream log entries

Unit tests: valid API key, invalid key, expired JWT, missing scope, malformed header.

**Done when:** Auth middleware unit tests pass; manual test with a valid and invalid key confirms correct 200/401 responses.

---

### T-06 · Rate limiting

**Owner:** BE | **Effort:** S | **Depends on:** T-05

Implement token-bucket rate limiting per API key using Redis.

- Default: 60 requests/min sustained, burst of 20
- Lua script in Redis for atomic token-bucket decrement (avoids race conditions)
- Return HTTP 429 with `RATE_LIMITED` error code and `Retry-After` header when limit exceeded
- Rate limit config read from `ApiSettings`

**Done when:** Unit test confirms 429 after 60+1 requests within a minute using `fakeredis`.

---

### T-07 · Request size enforcement

**Owner:** BE | **Effort:** XS | **Depends on:** T-04

Add a middleware check that rejects `message_body` exceeding 10,000 characters before the request reaches any pipeline logic.

- Checked in the route handler after Pydantic validation (Pydantic `max_length=10_000` handles this)
- Returns HTTP 413 with `MESSAGE_TOO_LONG` error code
- Write acceptance test mapping to AC-07

**Done when:** AC-07 acceptance criterion passes.

---

### T-08 · CI pipeline skeleton

**Owner:** Infra | **Effort:** M | **Depends on:** T-01

Set up GitHub Actions workflows.

- `ci.yml`: triggers on PR and push to `main`
  - Steps: checkout → install deps → `ruff` lint → `mypy` type check → `pytest` unit tests → coverage report (fail below 80%)
- `docker-build.yml`: builds Docker image on push to `main`, pushes to ECR tagged with Git SHA
- `Dockerfile`: multi-stage build (builder stage installs deps; runtime stage is slim Python 3.12 image, non-root user, read-only filesystem)
- `.github/dependabot.yml` for automated dependency updates

**Done when:** A PR with a lint error fails CI; a clean PR passes and the Docker image is pushed.

---

**M1 complete when:** T-01 through T-08 all pass. The API starts, auth works, CI is green, Docker image builds.

---

## Milestone 2 — Core Pipeline (No ML)

> Goal: end-to-end analysis pipeline working with rule-based scoring and URL checks. Returns valid responses with realistic scores. ML slot is mocked.

---

### T-09 · Ingestion and normalization

**Owner:** BE | **Effort:** M | **Depends on:** T-02, T-03

Implement `pipeline/ingestor.py`.

- Unicode NFC normalization via `unicodedata.normalize`
- Whitespace collapsing (consecutive whitespace → single space, trim)
- HTML stripping for email bodies: use `html.parser` to extract text, preserve link `href` values for URL extraction
- URL extraction:
  - Bare URLs matched with a compiled regex (handle `http://`, `https://`, and scheme-less `www.` prefixes)
  - `href` attributes from HTML
  - Markdown-style `[text](url)` links
  - Return list of raw extracted URLs (deduped, max 10)
- Channel metadata extraction:
  - `whatsapp`: parse `is_forwarded` bool and `forward_count` int from optional request fields
  - `sms`: normalize sender to E.164 format; detect short-link domains against a hardcoded list (`bit.ly`, `tinyurl.com`, `t.co`, `ow.ly`, etc.)
  - `email`: extract `from_domain`, `reply_to_domain`; compute `display_name_domain_mismatch` bool; extract subject
- Output: `NormalizedRequest` dataclass

Unit tests: HTML email with hidden href, forwarded WhatsApp metadata, E.164 normalization, URL deduplication, max-10 URL cap.

**Done when:** All unit tests pass; HTML-stripped text and extracted URLs are correct for a representative email fixture.

---

### T-10 · URL redirect follower

**Owner:** BE | **Effort:** S | **Depends on:** T-09

Implement the redirect-following component within `pipeline/ingestor.py` (called after URL extraction).

- Async `httpx` client with 500ms per-hop timeout
- Maximum 3 redirect hops
- Allowlist schemes: `http`, `https` only — reject `javascript:`, `ftp:`, etc. (SSRF prevention)
- Private IP range check: reject URLs resolving to RFC 1918 / loopback addresses before connecting
- Returns the final canonical URL (or the original if redirect fails or times out)

Unit tests: 3-hop redirect resolves correctly; 4th hop is ignored; non-http scheme is rejected; private IP is rejected.

**Done when:** Unit tests pass; integration test with a real redirect chain (e.g., `bit.ly` shortlink) resolves correctly.

---

### T-11 · Rule engine — keyword and regex matching

**Owner:** BE | **Effort:** L | **Depends on:** T-09

Implement `pipeline/rule_engine/engine.py` — the Aho-Corasick keyword matching and regex rule layer.

- Build a `pyahocorasick` automaton from `rules.yaml` keyword lists at startup
- `rules.yaml` structure:
  ```yaml
  keywords:
    - phrase: "verify your account"
      tag: credential_harvesting
      weight: 0.6
    - phrase: "click here immediately"
      tag: urgency
      weight: 0.5
    # ... ~150 entries covering all 9 tags
  regexes:
    - pattern: "\\b(your|the) account (will be|has been) (suspended|locked|closed)"
      tag: urgency
      weight: 0.65
    # ... ~40 patterns
  ```
- Compile all regex patterns once at startup
- For a given normalized text: run automaton + all regexes, collect all matches with character offsets
- Compute `rule_score` as a weighted mean of triggered rule weights, capped at 1.0
- Return `RuleEngineResult(rule_score, matched_phrases, hard_override=False)`
- Structural signals: ALL_CAPS ratio > 40% → +0.15; excessive punctuation (`!!!` or `???`) → +0.10

Unit tests covering all 9 scam tags; negative tests with clean messages; structural signal thresholds; score cap at 1.0.

**Done when:** A known phishing phrase returns the correct tag and a score > 0; a clean message returns score 0 and empty phrases.

---

### T-12 · Rule engine — blocklist matching

**Owner:** BE | **Effort:** M | **Depends on:** T-11

Extend `pipeline/rule_engine/engine.py` with blocklist support.

- Load domain blocklist and sender number blocklist from `pipeline/rule_engine/blocklists/` at startup into hash sets
- Blocklist files: `domains.txt` (one domain per line), `numbers.txt` (E.164 numbers)
- Seed files with a curated starter set of known phishing domains and smishing numbers (sourced from public blocklists: OpenPhish, PhishTank dump, abuse.ch)
- If any extracted URL's final domain matches the domain blocklist → `hard_override = True`
- If sender matches number blocklist → `hard_override = True`
- Lookalike detection: for each extracted domain, compute Levenshtein distance against a `top500_brands.txt` list; distance ≤ 2 → tag as `spoofed_url` with weight 0.8

Add a daily blocklist refresh mechanism: a script (`scripts/refresh_blocklists.py`) that fetches updated lists from public feeds and writes new files; runs as a Kubernetes CronJob.

Unit tests: known blocklisted domain triggers `hard_override`; lookalike `paypa1.com` is detected; clean domain is not flagged.

**Done when:** Blocklist hit forces `hard_override = True` in unit tests; CronJob manifest exists and script runs without errors.

---

### T-13 · Channel metadata analyzer

**Owner:** BE | **Effort:** S | **Depends on:** T-09

Implement `pipeline/channel_analyzer.py`.

- Input: `NormalizedRequest`
- Apply weight adjustments per `technical-design.md §3.7` signal table
- DNS-based SPF/DKIM/DMARC check for email channel using `aiodns`:
  - SPF: query TXT records for `from_domain`; absent or `~all`/`-all` mismatch → signal
  - DMARC: query TXT `_dmarc.{from_domain}`; absent → signal
  - DKIM: query TXT `{selector}._domainkey.{from_domain}`; selector extracted from email headers if provided
- Output: `ChannelSignals(total_adjustment: float, signals: list[str])`

Unit tests per channel type; mock DNS responses for SPF/DMARC checks.

**Done when:** An email with `from_domain ≠ reply_to_domain` produces the correct `+0.12` adjustment.

---

### T-14 · Redis client and caching layer

**Owner:** BE | **Effort:** S | **Depends on:** T-03

Implement `pipeline/cache.py` — a thin async Redis wrapper used by the URL checker and explanation generator.

- Async connection pool via `redis.asyncio`
- `get(key)` → `bytes | None`
- `set(key, value, ttl_seconds)`
- `hset` / `hget` for structured values
- All keys namespaced with a configurable prefix (e.g., `scam:`)
- Connection health check used by the `/ready` endpoint
- Tests use `fakeredis.aioredis`

**Done when:** Cache get/set/ttl round-trip unit tests pass with `fakeredis`.

---

### T-15 · URL reputation checker

**Owner:** BE | **Effort:** L | **Depends on:** T-10, T-14

Implement `pipeline/url_checker.py`.

- For each URL (parallel `asyncio.gather`, max 10):
  1. Cache lookup (`pipeline/cache.py`) — return cached score immediately on hit
  2. Google Safe Browsing API v4: `POST https://safebrowsing.googleapis.com/v4/threatMatches:find` with all 4 threat types; map response to `gsb_hit: bool`
  3. PhishTank API: `POST https://checkurl.phishtank.com/checkurl/` with URL; map `is_phishing` to bool
  4. Domain age via RDAP (`https://rdap.org/domain/{domain}`): parse `registration` date; flag if < 30 days old
  5. Homoglyph check: apply Unicode skeleton algorithm (using `confusable_homoglyphs` library) to domain; compare against `top500_brands.txt`
- Combine signals into `url_risk_score` (0.0–1.0): GSB hit → 0.95; PhishTank hit → 0.90; new domain → +0.20; homoglyph → 0.85
- Write result to cache with appropriate TTL (safe → 1h, malicious → 24h)
- Circuit breaker per external provider: open after 5 consecutive failures, half-open probe after 30s (`circuitbreaker` library)
- On full degradation: return neutral score 0.5 with `url_check_degraded: True`

Unit tests with mocked `httpx` responses for each provider; circuit breaker state transitions; cache hit short-circuits external calls.

**Done when:** A known PhishTank URL returns score ≥ 0.90; a cache hit skips external API calls; circuit breaker opens correctly after 5 failures.

---

### T-16 · Score merger

**Owner:** BE | **Effort:** S | **Depends on:** T-11, T-12, T-13, T-15

Implement `pipeline/score_merger.py`.

- Input: `RuleEngineResult`, `ChannelSignals`, list of URL scores, optional `MLResult` (None when ML is not yet integrated)
- Apply weighted formula from `technical-design.md §3.8`
- `hard_override` clamps final score to `max(score, 0.95)`
- `score_to_level()` mapping function
- All weights read from `ScoreWeights` config (tunable without code change)
- When `MLResult` is None (degraded/not-yet-integrated), distribute ML weight proportionally across rule and URL weights

Unit tests: weight combinations; hard override clamp; score clamping at 0.0 and 1.0; correct level mapping at all boundaries (0.39, 0.40, 0.69, 0.70, 0.89, 0.90).

**Done when:** All boundary unit tests pass; score with `hard_override=True` is always ≥ 0.95.

---

### T-17 · Recommendation engine

**Owner:** BE | **Effort:** M | **Depends on:** T-16

Implement `pipeline/recommender.py` and `config/recommendations.yaml`.

**YAML catalog:** Author all entries covering:
- High/critical universal: do not click, do not share info, delete message (3 entries)
- Per-channel reporting instructions: WhatsApp Report, SMS forward to 7726, email Report Phishing (3 entries)
- Medium risk: verify sender, do not call back numbers in message (2 entries)
- Low risk: informational only, be aware of common scam patterns (1 entry)
- Tag-specific: credential harvesting → change passwords; financial lure → verify with official source; threat → do not pay, contact authorities (3 entries)

Total: ~12 catalog entries covering all FR-15 through FR-20 requirements.

**Engine logic:**
- Load and parse `recommendations.yaml` at startup
- Filter entries where `risk_level` and `channel` and `tags` conditions all match
- Sort by `priority` ascending
- Deduplicate (same `id` can't appear twice)
- Return top 6

Unit tests: all 7 acceptance criteria mapped to recommendation outputs; AC-05 explicitly tested (critical always has "do not click").

**Done when:** AC-05 passes; recommendations for each channel/level combination are correct; max 6 are returned.

---

### T-18 · Template-based explanation generator

**Owner:** BE | **Effort:** M | **Depends on:** T-16

Implement the template path of `pipeline/explainer.py`.

- Author ~80 sentence templates in `config/explanation_templates.yaml`, organized by:
  - Primary tag (9 tags)
  - Risk level (low, medium — template mode; high/critical fall through to LLM in T-26)
  - Channel (optional override templates for email/sms/whatsapp)
- Template variable slots: `{channel}`, `{top_tag}`, `{top_phrase}`, `{sender_signal}`
- Template selection algorithm: pick the most specific template matching (tag + channel) → fall back to (tag only) → fall back to generic
- Fill slots from `RuleEngineResult` and `ChannelSignals`
- Enforce ≤ 3 sentence output via sentence splitting and truncation

Unit tests: template selected correctly per tag/channel combo; output never exceeds 3 sentences; missing variables degrade gracefully.

**Done when:** A low-risk message returns a non-empty explanation referencing its top tag.

---

### T-19 · Pipeline orchestrator

**Owner:** BE | **Effort:** M | **Depends on:** T-09, T-11, T-12, T-13, T-15, T-16, T-17, T-18

Implement `pipeline/orchestrator.py` — the main async coordinator.

- Accept `NormalizedRequest`; fan out to Rule Engine, URL Checker, Channel Analyzer using `asyncio.gather`
- Per-task timeouts enforced with `asyncio.wait_for`:
  - Rules: 100ms
  - URL checker: 800ms
  - Channel analyzer: 200ms
- On URL checker timeout: use neutral URL score 0.5, log warning, set `url_check_degraded=True`
- Pass results to Score Merger → Explanation Generator (template) → Recommendation Engine → Response Assembler
- Response Assembler merges rule + URL suspicious phrases, deduplicates by span overlap, caps at 20 phrases

Integration test: submit a synthetic phishing SMS fixture through the full orchestrator (with ML mocked as None) and assert all response fields are present and valid.

**Done when:** Integration test passes end-to-end; response schema validates against `AnalyzeResponse`.

---

### T-20 · API route — POST /v1/analyze

**Owner:** BE | **Effort:** S | **Depends on:** T-05, T-06, T-07, T-19

Implement `api/routes/analyze.py`.

- Wire auth dependency, rate limiting, and request size check
- Call `pipeline/orchestrator.py` with the validated request
- Set `analyzed_at` to current UTC time
- Return `AnalyzeResponse` serialized with `orjson`
- Map pipeline exceptions to correct HTTP error codes

End-to-end test covering all AC-01 through AC-07 acceptance criteria using the full stack with mocked external services.

**Done when:** All 7 acceptance criteria pass in an integration test.

---

**M2 complete when:** T-09 through T-20 all pass. `POST /v1/analyze` returns valid, scored responses using rule engine + URL checker. ML score is neutral (0.0) and weighted accordingly.

---

## Milestone 3 — ML Integration

> Goal: fine-tuned DeBERTa model trained, evaluated, served via TorchServe, and integrated into the live pipeline. Scores now reflect ML judgment.

---

### T-21 · Training data assembly and preprocessing

**Owner:** ML | **Effort:** L | **Depends on:** —

Assemble and preprocess the training dataset in `ml/data/`.

- Download and ingest public corpora:
  - SpamAssassin public corpus (ham + spam emails)
  - SMS Spam Collection dataset (UCI)
  - Enron email dataset (spam subset)
  - OpenPhish URLs matched against message templates
- Label each sample with the applicable scam taxonomy tags (multi-label); samples may have multiple tags
- Preprocessing pipeline (`ml/preprocess.py`):
  - Deduplicate by text hash
  - Filter non-English content (using `langdetect`)
  - Clean HTML, normalize Unicode
  - Assign `channel` label based on source dataset
- Synthetic augmentation for underrepresented tags (`prize_fraud`, `whatsapp` patterns):
  - Generate ~500 synthetic samples per underrepresented class using template-based generation with LLM assistance
  - Human review of a sample of synthetic data before inclusion
- Train/val/test split: 80/10/10 stratified by tag distribution
- Output: `train.jsonl`, `val.jsonl`, `test.jsonl` in consistent format

**Done when:** Dataset statistics report shows > 1,000 examples per tag in training split; class balance within acceptable range.

---

### T-22 · Model fine-tuning script

**Owner:** ML | **Effort:** L | **Depends on:** T-21

Implement `ml/train.py`.

- Base model: `microsoft/deberta-v3-base` loaded from HuggingFace Hub
- Two output heads added on top of pooled representation:
  - Binary head: `nn.Linear(hidden, 1)` + sigmoid → `scam_probability`
  - Multi-label head: `nn.Linear(hidden, 9)` + sigmoid → `tag_probabilities`
- Loss: `BCEWithLogitsLoss` for both heads; combined as `loss = 0.6 * binary_loss + 0.4 * tag_loss`
- Optimizer: AdamW with weight decay 0.01; linear warmup (10% of steps) + cosine decay
- Training: 5 epochs, batch size 64, gradient accumulation 2 (effective batch 128), FP16 mixed precision
- Experiment tracked in MLflow: log hyperparameters, per-epoch metrics, final test metrics
- Save best checkpoint (by validation F1) to `ml/checkpoints/`

**Done when:** Training script runs end-to-end on GPU; MLflow experiment is logged with loss curves and validation metrics.

---

### T-23 · Model evaluation and threshold calibration

**Owner:** ML | **Effort:** M | **Depends on:** T-22

Implement `ml/evaluate.py`.

- Load best checkpoint; run inference on held-out test set
- Report per-tag: precision, recall, F1, AUC-ROC, confusion matrix
- Report binary: precision, recall, F1 at the `high+critical` threshold (score ≥ 0.70)
- Calibrate classification threshold for the binary head using Platt scaling on validation set
- Gate: if precision < 0.92 or recall < 0.90 at high+critical threshold → training fails CI gate
- Save calibration parameters alongside model artifact
- Generate HTML evaluation report saved to `ml/reports/`

**Done when:** Evaluation metrics exceed the NFR-03/NFR-04 thresholds; CI gate blocks a deliberately undertrained model.

---

### T-24 · SHAP token attribution

**Owner:** ML | **Effort:** M | **Depends on:** T-22

Add SHAP explainability to the model inference path.

- Integrate `shap.Explainer` with the fine-tuned DeBERTa model
- For each inference, compute token-level SHAP values for the binary head
- Return top-5 tokens by absolute SHAP value as `TokenAttribution` objects
- SHAP computation must complete within 150ms on GPU (profile and optimize if needed — consider caching for repeated identical inputs)
- Unit test: SHAP values for a known phishing phrase highlight urgency-related tokens

**Done when:** SHAP values are returned per inference and top-5 tokens are plausible for test fixtures.

---

### T-25 · TorchServe model handler and gRPC server

**Owner:** ML + Infra | **Effort:** L | **Depends on:** T-23, T-24

Implement `ml/torchserve/handler.py` and configure TorchServe.

- Custom `BaseHandler` subclass:
  - `initialize()`: load model from S3 path (env var `MODEL_S3_PATH`), load calibration params, initialize SHAP explainer
  - `preprocess()`: tokenize input text with DeBERTa tokenizer (max 512 tokens, truncate with warning)
  - `inference()`: forward pass with FP16; apply calibration; compute SHAP values
  - `postprocess()`: format `ClassifyResponse` protobuf
- `ml/torchserve/config.properties`:
  - Enable gRPC on port 7070
  - Dynamic batching: `max_batch_size=32`, `batch_delay=10` (ms)
  - `num_workers=2` per GPU
- Proto file at `ml/torchserve/scam_classifier.proto` (matches `technical-design.md §14-C`)
- Generate Python stubs from proto
- Package model archive: `torch-model-archiver` → `.mar` file uploaded to S3

**Done when:** TorchServe starts, loads the model, and responds to a gRPC `Classify` call with correct output schema.

---

### T-26 · ML gRPC client and pipeline integration

**Owner:** BE | **Effort:** M | **Depends on:** T-19, T-25

Implement `pipeline/ml_client.py` and integrate into the orchestrator.

- Async gRPC channel to TorchServe using `grpcio` + generated stubs
- Connection pool: maintain 4 persistent channels, round-robin
- Per-call timeout: 1,500ms (hard limit from design)
- On timeout or gRPC error: log warning, return `None` → orchestrator uses `degraded=True` path
- Integrate into `pipeline/orchestrator.py`:
  - Add ML as Task B in `asyncio.gather`
  - Pass `ClassifyResponse.scam_probability` to Score Merger as `ml_score`
  - Pass `ClassifyResponse.tag_probabilities` to Response Assembler for suspicious phrase enrichment
  - Pass `ClassifyResponse.shap_tokens` to Explanation Generator

Integration test: orchestrator with real TorchServe (in Docker) returns a score reflecting ML output for a test phishing message.

**Done when:** Integration test passes; `risk_score` shifts meaningfully compared to rule-only baseline for ML-detected patterns.

---

### T-27 · LLM explanation generator (high/critical path)

**Owner:** BE | **Effort:** M | **Depends on:** T-14, T-26

Implement the LLM path in `pipeline/explainer.py`.

- Triggered when `risk_level` is `high` or `critical`
- Check LLM explanation cache first: key = `SHA256(normalized_text + channel)`, TTL = 24h
- Build structured prompt:
  ```
  You are a scam detection assistant. Explain in 2-3 sentences why the following message is likely a scam.
  Focus on: top detected signals, suspicious phrases, and URL findings.
  Be direct and factual. Do not use the words "scam" or "fraud" more than once.

  Detected signals: {tags}, Top phrases: {phrases}, URL findings: {url_summary},
  SHAP tokens: {shap_tokens}

  <message_content>
  {sanitized_text}
  </message_content>
  ```
- Call OpenAI `gpt-4o-mini` with `max_tokens=150`, `temperature=0`
- Enforce 2–3 sentence output: count sentences; truncate or retry once if violated
- Timeout: 400ms; fall back to template on timeout or API error
- Write successful response to cache

Unit tests: cache hit skips LLM call; timeout triggers template fallback; prompt injection via `<message_content>` delimiter is safe.

**Done when:** A high-risk fixture returns an LLM-generated explanation referencing detected signals; cache hit is confirmed on second identical request.

---

### T-28 · ML CI gate and model regression test suite

**Owner:** ML | **Effort:** M | **Depends on:** T-23, T-26

Build the model regression test suite that runs in CI on every code change.

- `tests/fixtures/labeled_messages.jsonl`: ~500 labeled fixtures (phishing emails, smishing SMS, WhatsApp scams, legitimate messages) with expected `risk_level` and expected tags
- Pytest parametrized test: run each fixture through the live orchestrator (TorchServe in Docker via `pytest-docker`)
- Assert: precision ≥ 0.92, recall ≥ 0.90 across the fixture set at high+critical threshold
- CI step in `ci.yml`: `pytest tests/ml_regression/ --timeout=300`
- A model that drops below threshold blocks merge

**Done when:** Regression suite catches a deliberately degraded model (one with random weights) and fails the CI gate.

---

**M3 complete when:** T-21 through T-28 all pass. The full pipeline — rules + ML + URL checker — produces calibrated, explainable scores. ML regression tests are in CI.

---

## Milestone 4 — Production Ready

> Goal: observability, security hardening, load testing, and infrastructure all in place for a production-grade service.

---

### T-29 · OpenTelemetry instrumentation

**Owner:** BE | **Effort:** M | **Depends on:** T-20

Add structured logging, metrics, and tracing throughout the codebase.

**Structured logging:**
- Replace all `print` statements with `structlog` JSON logger
- Log fields per request as specified in `technical-design.md §9.1`
- Confirm message body, sender, and subject are never present in any log output (add a log scrubber test)

**Metrics (OpenTelemetry → Prometheus):**
- Instrument all 7 metrics from `technical-design.md §9.2`
- Expose `/metrics` endpoint (Prometheus scrape target)

**Tracing:**
- Add `opentelemetry-instrumentation-fastapi` for automatic span creation
- Add manual spans for: rule engine, ML call, each URL check, explanation generation, recommendation engine
- Propagate `traceparent` header; correlate `request_id` with trace ID in logs

**Done when:** A single request produces a complete Jaeger trace with all pipeline stages visible as child spans.

---

### T-30 · Grafana dashboards and alerting rules

**Owner:** Infra | **Effort:** M | **Depends on:** T-29

Create Grafana dashboards and Prometheus alerting rules.

**Dashboards:**
- Overview: requests/sec, error rate, p50/p95/p99 latency, risk level distribution (pie chart)
- Pipeline: per-stage latency breakdown (rule engine, ML, URL checker), degraded request rate
- ML health: score distribution over time, per-tag detection rate, cache hit ratios
- Infrastructure: pod count, CPU/GPU utilization, Redis memory usage

**Alert rules** (`k8s/monitoring/alerts.yaml`) matching all 5 alerts in `technical-design.md §9.3`:
- P1: 5xx rate > 1% over 5 min
- P1: p95 latency > 2,000ms over 10 min
- P2: degraded requests > 5% of traffic
- P2: circuit breaker open > 5 min
- P3: score drift > 0.1 from 30-day baseline

**Done when:** All dashboards load from provisioned ConfigMaps; alert rules are syntactically valid (`promtool check rules`).

---

### T-31 · Kubernetes manifests

**Owner:** Infra | **Effort:** L | **Depends on:** T-08

Write all Kubernetes manifests in `k8s/`.

**Analysis Service** (`k8s/analysis-service.yaml`):
- `Deployment` with 3 replicas minimum, rolling update strategy (maxSurge 1, maxUnavailable 0)
- `HorizontalPodAutoscaler`: min 3, max 50, scale on CPU > 60%
- Non-root user, read-only root filesystem, dropped capabilities
- Liveness probe → `GET /health`, readiness probe → `GET /ready`
- Resource requests/limits (CPU: 500m/2000m, Memory: 512Mi/2Gi)
- `ConfigMap` for non-secret settings, `SecretProviderClass` for AWS Secrets Manager integration

**TorchServe** (`k8s/torchserve.yaml`):
- `Deployment` on GPU node pool (node selector + toleration for `nvidia.com/gpu`)
- `HPA`: min 2, max 10, scale on GPU utilization > 70% (custom metric via DCGM exporter)
- Resource limits: `nvidia.com/gpu: 1` per pod
- Init container: pull model `.mar` from S3 on startup

**Redis** (`k8s/redis.yaml`):
- Redis Cluster `StatefulSet`: 3 primaries + 3 replicas
- `PodDisruptionBudget`: max 1 unavailable at a time
- Persistence: `emptyDir` for URL/LLM cache (ephemeral is acceptable; cache misses degrade gracefully)

**Istio** (`k8s/istio/`):
- `PeerAuthentication`: mTLS STRICT for all pods in namespace
- `AuthorizationPolicy`: Analysis Service may only receive traffic from API Gateway; TorchServe only from Analysis Service
- `VirtualService` for canary split (20/80 during deployments)

**Done when:** `kubectl apply -k k8s/` deploys successfully to a staging cluster; all pods reach `Running` state; readiness probes pass.

---

### T-32 · Blocklist refresh CronJob

**Owner:** Infra | **Effort:** S | **Depends on:** T-12, T-31

Deploy the blocklist refresh script as a Kubernetes CronJob.

- `k8s/cronjobs/blocklist-refresh.yaml`: schedule `0 2 * * *` (daily at 02:00 UTC)
- Script fetches from: OpenPhish feed, abuse.ch URLhaus, PhishTank data dump
- Writes new `domains.txt` and `numbers.txt` to a shared `PersistentVolumeClaim` mounted by Analysis Service pods
- On completion, sends a `SIGHUP` to Analysis Service pods to reload blocklists without restart (implement `SIGHUP` handler in `api/main.py` that calls `rule_engine.reload_blocklists()`)
- Alert if CronJob fails 2 consecutive times

**Done when:** CronJob runs in staging; Analysis Service picks up updated blocklist without downtime.

---

### T-33 · ArgoCD GitOps setup and canary deployment

**Owner:** Infra | **Effort:** M | **Depends on:** T-31

Configure ArgoCD for GitOps continuous delivery.

- ArgoCD `Application` manifest pointing to `k8s/` directory in the repo
- Sync policy: automated, prune enabled, self-heal enabled
- Image update: `argocd-image-updater` watches ECR for new tags matching the Git SHA pattern; updates `k8s/analysis-service.yaml` and commits back to repo
- Canary rollout via Argo Rollouts:
  - Step 1: 20% traffic to new version for 10 minutes
  - Step 2: Prometheus analysis — abort if 5xx rate > 1% or p95 latency > 2,000ms
  - Step 3: promote to 100% on success; automatic rollback on abort
- Runbook: `docs/runbooks/rollback.md` describing manual rollback steps

**Done when:** Merging a code change to `main` triggers a full canary deploy to staging; a deliberately broken build auto-rolls back.

---

### T-34 · Security hardening and penetration test checklist

**Owner:** BE + Infra | **Effort:** M | **Depends on:** T-05, T-06, T-31

Work through the security checklist and remediate any findings.

- [ ] API key brute-force protection: rate limit auth failures independently (max 10 failed auth attempts/min per IP → block for 1h)
- [ ] JWT: verify `nbf` claim in addition to `exp`; add clock skew tolerance of 30s
- [ ] SSRF: confirm private IP blocklist covers IPv6 loopback (`::1`), link-local (`fe80::/10`), and AWS metadata endpoint (`169.254.169.254`)
- [ ] Prompt injection: add test fixture with `</message_content>` in the message body; confirm it does not break LLM prompt structure
- [ ] Log scrubbing: automated test confirms no PII fields appear in log output for any request fixture
- [ ] Dependency audit: `pip-audit` integrated into CI; fails on high/critical CVEs
- [ ] Container image scan: `trivy` scan integrated into Docker build CI step; fails on critical CVEs
- [ ] `Dockerfile`: confirm final image runs as `uid=1000`, no `sudo`, no writable paths outside `/tmp`
- [ ] Network policy: confirm pods cannot make unexpected egress (only to Redis, TorchServe, whitelisted external APIs)

**Done when:** All checklist items are ticked; `pip-audit` and `trivy` return no critical findings.

---

### T-35 · Load testing

**Owner:** BE + Infra | **Effort:** M | **Depends on:** T-31, T-33

Write and run `k6` load tests against the staging environment.

- `tests/load/k6_script.js`:
  - Ramp up to 500 virtual users over 2 minutes
  - Hold 500 VUs for 10 minutes
  - Ramp down over 1 minute
  - Mix of request types: 60% clean messages, 30% moderate scam, 10% high-risk with URLs
- Thresholds configured in script: p95 < 2,000ms, error rate < 0.1%
- Run against staging with full ML stack (TorchServe on GPU)
- Profile any p95 breaches using distributed traces from Jaeger

**Done when:** Load test passes all thresholds; results documented in `docs/load-test-results.md`.

---

### T-36 · Contract and property-based tests

**Owner:** BE | **Effort:** S | **Depends on:** T-20

Add `schemathesis` contract tests against the OpenAPI schema.

- Generate OpenAPI schema from FastAPI (`/openapi.json`)
- `tests/contract/test_api_contract.py`: `schemathesis.from_path(...)` generates and runs hundreds of property-based test cases
- Confirm every generated request produces a response conforming to the schema (no 500s, no schema violations)
- Run as part of CI after unit tests

**Done when:** `schemathesis` finds no schema violations; at least 500 generated test cases are executed.

---

**M4 complete when:** T-29 through T-36 all pass. Observability is live in staging, load test passes, security checklist is clean, GitOps deploy works.

---

## Milestone 5 — GA Launch

> Goal: production deployment verified, runbooks written, team trained.

---

### T-37 · Production environment provisioning

**Owner:** Infra | **Effort:** M | **Depends on:** T-33

Provision the production Kubernetes cluster and supporting infrastructure.

- Separate AWS account / GCP project for production (environment isolation)
- EKS/GKE cluster with dedicated GPU node pool for TorchServe
- Redis Cluster in a managed service (ElastiCache for Redis 7 cluster mode) or self-managed with backup
- AWS Secrets Manager: provision all secrets (GSB API key, PhishTank key, OpenAI key, JWT signing keys)
- DNS + TLS: domain configured, ACM/Let's Encrypt certificate, HSTS preloaded
- Production ArgoCD application pointing to `main` branch with manual sync approval gate for the first deploy

**Done when:** Production cluster passes the same readiness checks as staging; `/health` and `/ready` return 200.

---

### T-38 · Operational runbooks

**Owner:** BE + Infra | **Effort:** M | **Depends on:** T-30, T-33, T-37

Write runbooks in `docs/runbooks/`.

- `rollback.md`: how to roll back a bad deployment (ArgoCD UI + CLI steps)
- `ml-model-rollback.md`: how to revert `MODEL_VERSION` env var and restart TorchServe pods
- `blocklist-emergency-update.md`: how to manually add a domain/number to the blocklist outside of the daily cron
- `circuit-breaker-open.md`: what to do when the GSB/PhishTank/LLM circuit breaker is open (verify provider status, manual reset)
- `oncall.md`: escalation path, P1/P2/P3 definitions, alert → runbook mapping
- `new-model-deployment.md`: end-to-end guide for training, evaluating, and promoting a new model version

**Done when:** Each runbook is peer-reviewed by at least one engineer not involved in writing it.

---

### T-39 · Production smoke test and go-live

**Owner:** BE + Infra | **Effort:** S | **Depends on:** T-37, T-38

Verify production deployment with a smoke test suite before opening to users.

- Deploy to production via ArgoCD manual sync
- Run smoke test script (`scripts/smoke_test.py`):
  - `GET /health` → 200
  - `GET /ready` → 200
  - `POST /v1/analyze` with known phishing fixture → `risk_level: critical`
  - `POST /v1/analyze` with clean message → `risk_level: low`
  - `POST /v1/analyze` with invalid auth → HTTP 401
  - `POST /v1/analyze` with body > 10,000 chars → HTTP 413
- Confirm Grafana dashboard shows live traffic
- Confirm first alert fires correctly (trigger a synthetic 5xx spike)

**Done when:** All smoke test assertions pass in production; Grafana shows real traffic; on-call engineer is paged successfully by the test alert.

---

**M5 complete when:** T-37 through T-39 pass. Service is live in production, on-call is set up, runbooks are written.

---

## Summary Table

| Task | Title | Owner | Effort | Milestone | Depends On |
|---|---|---|---|---|---|
| T-01 | Project scaffold | BE | S | M1 | — |
| T-02 | Pydantic schemas | BE | S | M1 | T-01 |
| T-03 | App settings | BE | S | M1 | T-01 |
| T-04 | FastAPI entry point + health | BE | S | M1 | T-02, T-03 |
| T-05 | Auth middleware | BE | M | M1 | T-03, T-04 |
| T-06 | Rate limiting | BE | S | M1 | T-05 |
| T-07 | Request size enforcement | BE | XS | M1 | T-04 |
| T-08 | CI pipeline skeleton | Infra | M | M1 | T-01 |
| T-09 | Ingestion and normalization | BE | M | M2 | T-02, T-03 |
| T-10 | URL redirect follower | BE | S | M2 | T-09 |
| T-11 | Rule engine — keyword/regex | BE | L | M2 | T-09 |
| T-12 | Rule engine — blocklists | BE | M | M2 | T-11 |
| T-13 | Channel metadata analyzer | BE | S | M2 | T-09 |
| T-14 | Redis client and cache layer | BE | S | M2 | T-03 |
| T-15 | URL reputation checker | BE | L | M2 | T-10, T-14 |
| T-16 | Score merger | BE | S | M2 | T-11, T-12, T-13, T-15 |
| T-17 | Recommendation engine | BE | M | M2 | T-16 |
| T-18 | Template explanation generator | BE | M | M2 | T-16 |
| T-19 | Pipeline orchestrator | BE | M | M2 | T-09, T-11–T-13, T-15–T-18 |
| T-20 | API route POST /v1/analyze | BE | S | M2 | T-05–T-07, T-19 |
| T-21 | Training data assembly | ML | L | M3 | — |
| T-22 | Model fine-tuning script | ML | L | M3 | T-21 |
| T-23 | Model evaluation + calibration | ML | M | M3 | T-22 |
| T-24 | SHAP token attribution | ML | M | M3 | T-22 |
| T-25 | TorchServe handler + gRPC server | ML+Infra | L | M3 | T-23, T-24 |
| T-26 | ML gRPC client + pipeline integration | BE | M | M3 | T-19, T-25 |
| T-27 | LLM explanation generator | BE | M | M3 | T-14, T-26 |
| T-28 | ML CI gate + regression suite | ML | M | M3 | T-23, T-26 |
| T-29 | OpenTelemetry instrumentation | BE | M | M4 | T-20 |
| T-30 | Grafana dashboards + alerts | Infra | M | M4 | T-29 |
| T-31 | Kubernetes manifests | Infra | L | M4 | T-08 |
| T-32 | Blocklist refresh CronJob | Infra | S | M4 | T-12, T-31 |
| T-33 | ArgoCD GitOps + canary deploy | Infra | M | M4 | T-31 |
| T-34 | Security hardening checklist | BE+Infra | M | M4 | T-05, T-06, T-31 |
| T-35 | Load testing | BE+Infra | M | M4 | T-31, T-33 |
| T-36 | Contract + property-based tests | BE | S | M4 | T-20 |
| T-37 | Production provisioning | Infra | M | M5 | T-33 |
| T-38 | Operational runbooks | BE+Infra | M | M5 | T-30, T-33, T-37 |
| T-39 | Production smoke test + go-live | BE+Infra | S | M5 | T-37, T-38 |

---

## Effort Totals by Milestone

| Milestone | Tasks | Total Effort |
|---|---|---|
| M1 — Foundation | T-01 to T-08 | ~7 days |
| M2 — Core Pipeline | T-09 to T-20 | ~13 days |
| M3 — ML Integration | T-21 to T-28 | ~14 days |
| M4 — Production Ready | T-29 to T-36 | ~11 days |
| M5 — GA Launch | T-37 to T-39 | ~5 days |
| **Total** | **39 tasks** | **~50 engineer-days** |

With a 2-person team (1 BE + 1 ML/Infra) working in parallel, M3 (ML) can overlap with M2 (pipeline) from T-21 onward, compressing the calendar timeline to approximately **7–8 weeks**.
