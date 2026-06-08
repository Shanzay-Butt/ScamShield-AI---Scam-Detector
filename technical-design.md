# AI Scam Detector — Technical Design Document

**Version:** 1.0  
**Date:** June 6, 2026  
**Status:** Draft  
**Refs:** `requirements.md` v1.0

---

## 1. Introduction

This document describes the technical architecture, component design, data flows, and implementation decisions for the AI Scam Detector service. It is intended for backend engineers and ML engineers building and maintaining the system.

The service exposes a single REST endpoint (`POST /v1/analyze`) that accepts a message payload and returns a structured scam analysis result. The core pipeline combines a rule-based pre-filter, a fine-tuned transformer model for text classification, a URL reputation checker, and a channel-specific metadata analyzer. Results are assembled and returned synchronously within a 2-second p95 budget.

---

## 2. System Architecture

### 2.1 High-Level Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                          API Gateway                            │
│              (TLS termination · Auth · Rate Limiting)           │
└───────────────────────────────┬─────────────────────────────────┘
                                │ HTTPS POST /v1/analyze
                                ▼
┌─────────────────────────────────────────────────────────────────┐
│                       Analysis Service                          │
│                                                                 │
│  ┌─────────────┐   ┌──────────────┐   ┌─────────────────────┐  │
│  │  Ingestion  │──▶│   Pipeline   │──▶│  Response Assembler │  │
│  │  & Validator│   │  Orchestrator│   │                     │  │
│  └─────────────┘   └──────┬───────┘   └─────────────────────┘  │
│                           │                                     │
│          ┌────────────────┼────────────────┐                    │
│          ▼                ▼                ▼                    │
│  ┌──────────────┐ ┌──────────────┐ ┌──────────────────────┐    │
│  │  Rule-Based  │ │  ML Classifier│ │  URL Reputation      │    │
│  │  Pre-filter  │ │  (Transformer)│ │  Checker             │    │
│  └──────────────┘ └──────────────┘ └──────────────────────┘    │
│                                                                 │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │              Channel Metadata Analyzer                   │   │
│  │         (WhatsApp · SMS · Email enrichment)              │   │
│  └──────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────┘
                                │
                    ┌───────────┴───────────┐
                    ▼                       ▼
          ┌──────────────────┐   ┌─────────────────────┐
          │  URL Reputation  │   │  Explanation & Rec.  │
          │  External API    │   │  LLM (async, cached) │
          │  (Google Safe    │   │                      │
          │   Browsing /     │   └─────────────────────┘
          │   PhishTank)     │
          └──────────────────┘
```

### 2.2 Deployment Model

The system is deployed as a containerized microservice on Kubernetes. Each component that has independent scaling needs runs as a separate deployment. Communication between internal components is in-process (within the same pod) for low-latency components and over gRPC for the ML model server.

| Component | Deployment Unit | Scaling Trigger |
|---|---|---|
| API Gateway | Managed (e.g., AWS API GW / Kong) | Requests/sec |
| Analysis Service | Kubernetes Deployment | CPU + request queue depth |
| ML Model Server | Kubernetes Deployment (GPU nodes) | Inference queue depth |
| URL Reputation Cache | Redis Cluster | Memory |
| Recommendation Engine | In-process library | N/A |

---

## 3. Component Design

### 3.1 API Gateway

Responsibilities:
- TLS 1.2+ termination
- Authentication: API key lookup (hashed key in Redis) or OAuth 2.0 JWT validation (RS256, verified against JWKS endpoint)
- Rate limiting: token-bucket per API key, configurable limit (default 60 req/min, burst 20)
- Request size enforcement: reject payloads where `message_body` > 10,000 characters before forwarding
- Request ID generation: UUID v4 injected into `X-Request-ID` header and propagated downstream

Error responses at this layer return before the Analysis Service is invoked, keeping latency minimal.

### 3.2 Ingestion & Validator

The first stage inside the Analysis Service. Responsible for:

1. **Parsing** the JSON request body into an internal `AnalysisRequest` struct.
2. **Normalizing** the message body: Unicode normalization (NFC), whitespace collapsing, HTML stripping (for email bodies submitted as HTML).
3. **Extracting URLs** using a regex-based extractor that handles bare URLs, href attributes, and markdown-style links. All URLs are resolved through a redirect-follower (max 3 hops, 500ms timeout) to obtain the final destination domain.
4. **Extracting metadata signals** per channel:
   - `whatsapp`: `is_forwarded`, `forward_count` (parsed from client-provided metadata fields)
   - `sms`: sender number normalization (E.164), short-link domain detection
   - `email`: `from_domain`, `reply_to_domain`, `display_name`, `subject`, domain-display name mismatch flag

Output: `NormalizedRequest` passed to the Pipeline Orchestrator.

### 3.3 Pipeline Orchestrator

Coordinates the three parallel analysis branches and merges their outputs. Uses an async task runner (Python `asyncio` with `asyncio.gather`) to run branches concurrently, respecting the 2-second total budget.

```
NormalizedRequest
       │
       ├──▶ [Task A] Rule-Based Pre-filter       ─┐
       ├──▶ [Task B] ML Classifier (gRPC)         ├──▶ Score Merger ──▶ Response Assembler
       └──▶ [Task C] URL Reputation Checker       ─┘
                     + Channel Metadata Analyzer
```

Each task has an individual timeout:
- Task A (rules): 100ms hard limit
- Task B (ML): 1,500ms hard limit
- Task C (URL): 800ms hard limit (per-URL; URLs checked in parallel)

If Task B times out, the system falls back to the rule-based score only and sets a `degraded: true` flag in the response (not user-visible, logged for observability).

### 3.4 Rule-Based Pre-filter

A fast, deterministic layer that runs before the ML model. It provides:

1. **Instant high-confidence decisions** — known scam domains, known scam number blocklists → forces `risk_score ≥ 0.95` regardless of ML output.
2. **Feature signals** passed to the Score Merger to supplement ML output.
3. **Suspicious phrase extraction** — regex and keyword matching against the scam taxonomy (see §7 of requirements). Each match records the matched span (start/end character offset) and the assigned tag.

Rule categories:

| Rule Type | Implementation | Examples |
|---|---|---|
| Keyword match | Trie-based lookup (Aho-Corasick) | "verify your account", "click here immediately" |
| Regex pattern | Compiled regex set | Phone number impersonation, OTP harvesting patterns |
| Domain blocklist | Hash set lookup | Known phishing domains updated daily |
| Sender blocklist | Hash set lookup | Known smishing numbers |
| Lookalike domain | Edit-distance check against top-500 brand list (Levenshtein ≤ 2) | `paypa1.com`, `arnazon.co.uk` |
| Structural signals | Heuristic | ALL_CAPS ratio > 40%, excessive punctuation `!!!` |

The rule engine outputs:
- `rule_score`: float 0.0–1.0 (weighted average of triggered rule weights)
- `matched_phrases`: list of `{phrase, tag, start, end}` objects
- `hard_override`: bool (true if a blocklist match occurred)

### 3.5 ML Classifier

A fine-tuned transformer model that classifies messages as scam/legitimate and produces per-class probability scores across the 9 scam pattern tags.

#### Model Choice

**Base model:** `microsoft/deberta-v3-base`  
Chosen for its strong performance on sequence classification tasks with relatively short texts, and its superior handling of linguistic variation compared to BERT-family models. The smaller footprint (86M parameters) fits the latency budget.

#### Fine-tuning

- **Dataset:** A combination of publicly available phishing/spam corpora (SpamAssassin, Enron spam, SMS Spam Collection) augmented with synthetically generated examples for underrepresented scam types (prize fraud, WhatsApp-specific patterns).
- **Task:** Multi-label classification across 9 tags + a binary scam/ham head.
- **Training:** Fine-tuned on 4× A100 GPUs, AdamW optimizer, linear warmup + cosine decay schedule, 5 epochs, batch size 64.
- **Output:** Two heads:
  - `scam_probability`: single float (sigmoid over binary head logit)
  - `tag_probabilities`: dict of `{tag: probability}` for each of the 9 taxonomy tags

#### Serving

The model is served via **TorchServe** behind a gRPC interface. The Analysis Service calls it with:

```protobuf
message ClassifyRequest {
  string request_id = 1;
  string normalized_text = 2;
  string channel = 3;
}

message ClassifyResponse {
  float scam_probability = 1;
  map<string, float> tag_probabilities = 2;
  int32 inference_latency_ms = 3;
}
```

Model artifacts are stored in S3 and pulled at pod startup. Model version is pinned via a `MODEL_VERSION` environment variable; rollback is a config change + rolling restart.

#### Explainability

SHAP (SHapley Additive exPlanations) values are computed for the top contributing tokens in each inference. The top-5 SHAP tokens are returned alongside the `ClassifyResponse` and used by the Response Assembler to construct the plain-language explanation.

### 3.6 URL Reputation Checker

Runs in parallel for each URL extracted from the message (max 10 URLs per message; additional URLs are skipped and noted in logs).

**Check pipeline per URL (all checks run in parallel):**

1. **Cache lookup** — Check Redis cache (TTL: 1 hour for safe, 24 hours for malicious) to avoid redundant external calls.
2. **Google Safe Browsing API v4** — `threatMatches.find` call. Checks `MALWARE`, `SOCIAL_ENGINEERING`, `UNWANTED_SOFTWARE`, `POTENTIALLY_HARMFUL_APPLICATION`.
3. **PhishTank API** — `checkurl` call. Returns `is_phishing` bool + confidence.
4. **Domain age check** — WHOIS lookup via a local rdap client. Domains registered < 30 days ago receive a `new_domain` signal.
5. **Homoglyph / lookalike detection** — Compares the domain against the top-500 brand list using Unicode skeleton algorithm (confusable characters) + Levenshtein distance.

**URL risk score:** Weighted combination of the above signals, normalized to 0.0–1.0.

If external APIs are unavailable (circuit breaker open), the URL score falls back to the domain reputation cache. If the cache is also cold, the URL receives a neutral score of 0.5 with a `url_check_degraded: true` signal.

### 3.7 Channel Metadata Analyzer

Enriches the normalized request with channel-specific risk signals that are factored into the Score Merger.

| Channel | Signal | Weight |
|---|---|---|
| `whatsapp` | `is_forwarded`: +0.05 | Low |
| `whatsapp` | `forward_count > 5`: +0.15 | Medium |
| `sms` | Sender not in contacts (unknown number) + high text risk: +0.10 | Medium |
| `sms` | Short-link domain (bit.ly, tinyurl, etc.): +0.08 | Medium |
| `email` | `from_domain` ≠ `reply_to_domain`: +0.12 | Medium-High |
| `email` | Display name / From domain mismatch: +0.18 | High |
| `email` | Sender domain age < 30 days: +0.10 | Medium |
| `email` | Missing SPF/DKIM/DMARC (checked via DNS): +0.15 | Medium-High |

### 3.8 Score Merger

Combines outputs from all three branches into a single `risk_score`.

**Formula:**

```
final_score = clip(
    w_ml  * ml_score
  + w_rule * rule_score
  + w_url  * max(url_scores)   # worst URL dominates
  + Σ channel_metadata_adjustments,
  0.0, 1.0
)
```

Default weights (tunable via config):

| Signal | Weight |
|---|---|
| `w_ml` (ML classifier) | 0.55 |
| `w_rule` (rule-based) | 0.25 |
| `w_url` (URL reputation) | 0.20 |

If `hard_override = true` (blocklist match), `final_score` is clamped to `max(final_score, 0.95)`.

`risk_level` mapping:

```python
def score_to_level(score: float) -> str:
    if score < 0.40:  return "low"
    if score < 0.70:  return "medium"
    if score < 0.90:  return "high"
    return "critical"
```

### 3.9 Explanation Generator

Produces the plain-language `explanation` string (≤ 3 sentences, per FR-11).

Two modes depending on risk level:

**Low / Medium** — Template-based generation. A library of ~80 sentence templates parameterized by the top contributing signals. Templates are selected and filled deterministically, ensuring consistency and avoiding LLM latency for the majority of non-critical requests.

Example template:
```
"This {channel} message contains language commonly associated with {top_tag} scams. 
 {top_phrase_context}. 
 Exercise caution before responding or clicking any links."
```

**High / Critical** — An LLM call (GPT-4o-mini or an equivalent hosted model) is made asynchronously with a structured prompt that includes the top SHAP tokens, matched phrases, URL findings, and channel signals. The LLM is instructed to produce exactly 2–3 sentences. This is cached per content hash (SHA-256 of normalized text) with a 24-hour TTL to avoid redundant calls for repeated scam messages.

If the LLM call fails or exceeds 400ms, the system falls back to template-based generation.

### 3.10 Recommendation Engine

A rule-driven engine that selects and orders recommendations based on `risk_level`, detected tags, and channel. Recommendations are drawn from a structured YAML catalog:

```yaml
recommendations:
  - id: no_click
    text: "Do not click any links in this message."
    applies_when:
      risk_levels: [high, critical]
      tags: [spoofed_url, credential_harvesting]
    priority: 1

  - id: no_info
    text: "Do not provide any personal or financial information."
    applies_when:
      risk_levels: [high, critical]
    priority: 2

  - id: report_whatsapp
    text: "Report this message using WhatsApp's built-in 'Report' feature."
    applies_when:
      risk_levels: [medium, high, critical]
      channels: [whatsapp]
    priority: 3
  ...
```

The engine evaluates all catalog entries against the current analysis context, filters applicable ones, sorts by priority, and deduplicates. Maximum 6 recommendations are returned.

### 3.11 Response Assembler

Merges all component outputs into the final API response object:

```python
@dataclass
class AnalysisResponse:
    request_id: str
    channel: str
    risk_score: float          # rounded to 2 decimal places
    risk_level: str
    explanation: str
    suspicious_phrases: list[SuspiciousPhrase]
    recommendations: list[str]
    analyzed_at: str           # ISO 8601 UTC
```

`suspicious_phrases` is the union of rule-engine matched phrases and ML tag detections with `tag_probability > 0.6`, deduplicated by span overlap.

---

## 4. Data Flow

### 4.1 Request Lifecycle

```
Client
  │
  │ POST /v1/analyze  (TLS, Auth header)
  ▼
API Gateway
  │ Validates auth, rate limit, payload size
  │ Injects X-Request-ID
  ▼
Analysis Service — Ingestion & Validator
  │ Normalizes text, extracts URLs, builds NormalizedRequest
  ▼
Pipeline Orchestrator  (asyncio.gather)
  ├──▶ Rule-Based Pre-filter ─────────────────────────────────┐
  ├──▶ ML Classifier (gRPC → TorchServe) ────────────────────┤
  └──▶ URL Reputation Checker (parallel per URL) ────────────┤
                                                              │
                                                     Score Merger
                                                              │
                                              Explanation Generator
                                                              │
                                             Recommendation Engine
                                                              │
                                              Response Assembler
                                                              │
  ◀──────────────────────────────────────────────────── JSON Response
Client
```

### 4.2 Data Handled Per Request

| Data | Stored? | Lifetime |
|---|---|---|
| `message_body` | No | In-memory for duration of request only |
| `sender` | No | In-memory for duration of request only |
| Extracted URLs | Yes — Redis cache key (hashed) | Cache TTL (1h–24h) |
| Explanation LLM cache | Yes — Redis (keyed by content hash) | 24h TTL |
| Request logs (no message content) | Yes — structured log | 30 days |
| Metrics (latency, score distribution) | Yes — time-series DB | 90 days |

Message content is never written to disk or sent to external parties in plaintext. URL cache keys are SHA-256 hashes of the URL, not the full URL.

---

## 5. Technology Stack

| Layer | Technology | Rationale |
|---|---|---|
| API Gateway | Kong (self-hosted) or AWS API Gateway | Auth, rate limiting, TLS offload out of the box |
| Analysis Service | Python 3.12, FastAPI | Async support, clean typing, fast JSON serialization via `orjson` |
| ML Model Server | TorchServe 0.9 | Native PyTorch integration, gRPC support, batching |
| Transformer Model | DeBERTa-v3-base (fine-tuned) | Best-in-class short text classification within latency budget |
| Explainability | SHAP (`shap` library) | Token-level attribution without architectural changes |
| Async task runner | Python `asyncio` | In-process parallelism without inter-service overhead |
| Caching | Redis 7 (Cluster mode) | Low-latency key-value store for URL reputation and LLM cache |
| URL extraction | `urllib.parse` + custom regex | Standard library, no external dependency |
| Redirect following | `httpx` (async) | Async HTTP client with timeout support |
| External URL APIs | Google Safe Browsing v4, PhishTank | Industry-standard threat intel |
| DNS lookups | `aiodns` | Async DNS resolution for SPF/DKIM/DMARC checks |
| Serialization | `pydantic` v2 | Request validation and response schema enforcement |
| Containerization | Docker + Kubernetes | Horizontal scaling, rolling deploys |
| Service mesh | Istio | mTLS between internal services, observability |
| Observability | OpenTelemetry → Grafana / Jaeger | Distributed tracing, metrics, alerting |
| CI/CD | GitHub Actions + ArgoCD | Automated testing, GitOps deployment |

---

## 6. Security Design

### 6.1 Authentication

Two supported modes:

**API Key**
- Keys are 32-byte random values, stored as HMAC-SHA256 hashes in Redis.
- Incoming key is hashed and compared; the plaintext key is never stored.
- Key rotation is supported; old keys remain valid for a 24h grace period after rotation.

**OAuth 2.0 / JWT**
- Bearer token validated as RS256 JWT against a JWKS endpoint.
- Required claims: `sub`, `exp`, `iss`, `scope: scam-detector:analyze`.
- Tokens are validated in-memory; no external call per request after JWKS is cached.

### 6.2 Transport Security

- TLS 1.2 minimum, TLS 1.3 preferred.
- HSTS enforced at the gateway.
- Internal gRPC calls (Analysis Service ↔ TorchServe) use mTLS via Istio.

### 6.3 Data Isolation

- Each request is processed in an isolated async context with no shared mutable state between requests.
- No message content is logged. Structured logs include only: `request_id`, `channel`, `risk_level`, `risk_score`, `latency_ms`, `tags_detected`, `url_count`.
- Kubernetes pods run as non-root with read-only root filesystem. Secrets are injected via Kubernetes Secrets (backed by AWS Secrets Manager).

### 6.4 Input Validation & Injection Prevention

- `message_body` is treated as opaque text throughout. It is never interpolated into SQL, shell commands, or LLM system prompts without sanitization.
- LLM prompt construction wraps message content in delimited blocks to prevent prompt injection:
  ```
  <message_content>
  {sanitized_content}
  </message_content>
  ```
- URL redirect-following uses an allowlist of schemes (`http`, `https` only) with a maximum of 3 hops and a 500ms per-hop timeout to prevent SSRF.

### 6.5 Rate Limiting

- Per API key: token bucket, 60 req/min sustained, burst of 20.
- Global circuit breaker on external APIs (Google Safe Browsing, PhishTank, LLM): opens after 5 consecutive failures, half-open probe after 30s.

---

## 7. ML Model Lifecycle

### 7.1 Training Pipeline

```
Raw Data Sources
(SpamAssassin, SMS Spam Collection, synthetic augmentation)
        │
        ▼
Data Preprocessing
(deduplication, language filtering, label cleaning, train/val/test split 80/10/10)
        │
        ▼
Fine-tuning Job (GPU cluster, tracked in MLflow)
        │
        ▼
Evaluation (precision, recall, F1 per tag, confusion matrix)
        │
   Pass threshold?
    Yes │       No
        │        └──▶ Hyperparameter tuning / data augmentation
        ▼
Model Registry (MLflow) ──▶ S3 artifact storage
        │
        ▼
Shadow Deployment (new model runs alongside production, no traffic impact)
        │
  A/B Test (5% traffic)
        │
   Metrics acceptable?
    Yes │
        ▼
Full Rollout (rolling restart of TorchServe pods)
```

### 7.2 Model Versioning

Models are identified by `{model_name}-v{semver}` (e.g., `scam-deberta-v1.2.0`). The active version is controlled by a `MODEL_VERSION` environment variable in the TorchServe deployment. Rollback is a one-line config change.

### 7.3 Monitoring & Drift Detection

- **Prediction distribution monitoring:** Score distribution is tracked in Grafana. An alert fires if the daily median score shifts > 0.1 from the 30-day rolling baseline (may indicate concept drift or data pipeline issues).
- **Tag frequency monitoring:** Per-tag detection rate tracked weekly. Sudden spikes indicate new scam campaigns; sudden drops may indicate model degradation.
- **Ground truth labeling:** A sample of 1% of requests (with explicit user consent; message content replaced with anonymized feature vectors) is sent to human reviewers quarterly for ground truth labeling and model retraining.

---

## 8. Scalability & Performance

### 8.1 Latency Budget Breakdown

Total budget: 2,000ms (p95)

| Stage | Budget | Notes |
|---|---|---|
| API Gateway overhead | 20ms | Auth, rate limit, routing |
| Ingestion & Validation | 30ms | Text normalization, URL extraction |
| Rule-Based Pre-filter | 50ms | Aho-Corasick + regex, very fast |
| ML Inference (gRPC) | 400ms | DeBERTa-v3-base on GPU; batching helps under load |
| URL Reputation (parallel) | 500ms | External API calls dominate; Redis cache hit → 5ms |
| Explanation Generation (template) | 30ms | Template fill, no LLM |
| Explanation Generation (LLM, cached) | 50ms | Cache hit only within budget |
| Recommendation Engine | 20ms | Rule evaluation over small catalog |
| Response Assembly + Serialization | 20ms | pydantic v2 + orjson |
| **Total (p95 target)** | **~1,120ms** | 880ms headroom for variance |

The LLM explanation path for high/critical messages without a cache hit is run with a 400ms timeout and falls back to templates if exceeded. The full LLM call (if it takes up to 1,500ms) is acceptable for p99 but is excluded from the p95 commitment via the fallback.

### 8.2 Horizontal Scaling

- Analysis Service pods: autoscale on CPU utilization > 60% (HPA), min 3 replicas, max 50.
- TorchServe pods: autoscale on GPU utilization > 70% and request queue depth > 100, min 2 replicas (GPU nodes), max 10.
- Redis: Cluster mode with 3 primary + 3 replica nodes. Read requests served from replicas.

### 8.3 ML Inference Batching

TorchServe is configured with dynamic batching:
- Max batch size: 32
- Max batch delay: 10ms

Under high load, multiple concurrent requests are batched into a single GPU forward pass, dramatically improving throughput without meaningfully increasing per-request latency.

### 8.4 Caching Strategy

| Cache | Key | TTL | Purpose |
|---|---|---|---|
| URL reputation | `SHA256(canonical_url)` | 1h (safe), 24h (malicious) | Avoid repeated external API calls for same URL |
| LLM explanation | `SHA256(normalized_text + channel)` | 24h | Avoid redundant LLM calls for repeated scam messages |
| API key lookup | `HMAC(raw_key)` | 5min | Reduce Redis round-trips for auth |
| JWKS public keys | In-memory | 1h, refresh on 401 | Avoid JWKS endpoint call per request |

---

## 9. Observability

### 9.1 Structured Logging

All logs are JSON, emitted to stdout, collected by Fluent Bit, and shipped to a centralized log aggregator (e.g., OpenSearch).

Log fields per request:
```json
{
  "timestamp": "2026-06-06T14:32:00.123Z",
  "request_id": "550e8400-e29b-41d4-a716-446655440000",
  "level": "INFO",
  "channel": "email",
  "risk_level": "critical",
  "risk_score": 0.91,
  "tags_detected": ["urgency", "spoofed_url"],
  "url_count": 2,
  "ml_latency_ms": 320,
  "total_latency_ms": 870,
  "degraded": false,
  "cache_hits": ["url_reputation"]
}
```

Message body, sender, and subject are never logged.

### 9.2 Metrics

Exported via OpenTelemetry to Prometheus / Grafana:

| Metric | Type | Description |
|---|---|---|
| `scam_detector_requests_total` | Counter | Total requests, labeled by channel and risk_level |
| `scam_detector_request_duration_ms` | Histogram | End-to-end latency |
| `scam_detector_ml_duration_ms` | Histogram | ML inference latency |
| `scam_detector_url_check_duration_ms` | Histogram | URL check latency |
| `scam_detector_cache_hit_ratio` | Gauge | URL and LLM cache hit rates |
| `scam_detector_degraded_requests_total` | Counter | Requests served in degraded mode |
| `scam_detector_external_api_errors_total` | Counter | External API failures by provider |

### 9.3 Alerts

| Alert | Condition | Severity |
|---|---|---|
| High error rate | 5xx rate > 1% over 5 min | P1 |
| Latency SLO breach | p95 latency > 2,000ms over 10 min | P1 |
| ML inference degraded | `degraded_requests_total` > 5% of traffic | P2 |
| External API circuit open | Circuit breaker open for > 5 min | P2 |
| Score drift | Daily median score shifts > 0.1 | P3 |

### 9.4 Distributed Tracing

OpenTelemetry traces with spans for each pipeline stage (ingestion, rule filter, ML inference, URL checks, explanation, recommendation, assembly). Trace IDs are propagated via `traceparent` headers and correlated with `request_id`.

---

## 10. API Design

### 10.1 Endpoint

```
POST /v1/analyze
```

### 10.2 Request Schema (Pydantic)

```python
class AnalyzeRequest(BaseModel):
    message_body: str = Field(..., min_length=1, max_length=10_000)
    channel: Literal["whatsapp", "sms", "email", "unknown"] = "unknown"
    sender: str | None = Field(None, max_length=256)
    subject: str | None = Field(None, max_length=998)   # RFC 5322 limit
    reply_to: str | None = Field(None, max_length=256)
```

### 10.3 Response Schema

```python
class SuspiciousPhrase(BaseModel):
    phrase: str
    tag: Literal[
        "urgency", "impersonation", "credential_harvesting",
        "financial_lure", "prize_fraud", "threat", "spoofed_url",
        "unsolicited_attachment", "personal_info_request"
    ]

class AnalyzeResponse(BaseModel):
    request_id: str
    channel: str
    risk_score: float        # 0.00 – 1.00, 2 decimal places
    risk_level: Literal["low", "medium", "high", "critical"]
    explanation: str
    suspicious_phrases: list[SuspiciousPhrase]
    recommendations: list[str]
    analyzed_at: datetime
```

### 10.4 Error Schema

```python
class ErrorResponse(BaseModel):
    error_code: str
    message: str
    request_id: str
```

---

## 11. Testing Strategy

### 11.1 Unit Tests

- Rule engine: each rule type tested with positive and negative fixtures.
- Score merger: boundary conditions for all weight combinations and clamp behavior.
- Recommendation engine: each catalog entry tested against its applicability conditions.
- URL extractor: edge cases (bare URLs, encoded URLs, nested redirects).

### 11.2 Integration Tests

- Full pipeline integration test against a local TorchServe instance with a small test model.
- URL reputation checker tested against mock HTTP servers simulating Google Safe Browsing and PhishTank responses.
- Redis cache behavior tested with an in-process Redis test server (e.g., `fakeredis`).

### 11.3 ML Evaluation

- Held-out test set evaluation on every model training run, tracked in MLflow.
- Regression test suite: ~500 labeled message fixtures (phishing, smishing, legitimate) run as part of CI. Any drop in precision below 92% or recall below 90% blocks deployment.

### 11.4 Contract Tests

- API contract tests using `schemathesis` (property-based testing against the OpenAPI schema).
- Ensures the response always conforms to the defined schema, including edge cases like empty `suspicious_phrases`.

### 11.5 Load Tests

- `k6` load test script simulating 500 concurrent users.
- Acceptance criterion: p95 latency < 2,000ms, error rate < 0.1%.
- Run nightly in a staging environment.

---

## 12. Deployment & Operations

### 12.1 Environments

| Environment | Purpose | Traffic |
|---|---|---|
| `dev` | Local development, mocked external services | Developer only |
| `staging` | Integration testing, load testing, shadow ML | No real user traffic |
| `production` | Live service | All user traffic |

### 12.2 Deployment Process

1. PR merged to `main` → CI runs unit tests, integration tests, contract tests, ML regression tests.
2. Docker images built and pushed to ECR with the Git SHA as the image tag.
3. ArgoCD detects the new image tag and syncs the Kubernetes manifests (GitOps).
4. Rolling deployment with a 20% canary phase: new pods receive 20% of traffic for 10 minutes. If error rate or latency SLO is breached, ArgoCD automatically rolls back.
5. Full rollout on success.

### 12.3 Configuration Management

All tunable parameters (model weights, rule weights, rate limits, timeout values, recommendation catalog) are managed via Kubernetes ConfigMaps and environment variables. Changes to config do not require a code deployment — only a pod restart. Sensitive values (API keys for Google Safe Browsing, PhishTank, LLM provider) are stored in AWS Secrets Manager and injected at runtime.

---

## 13. Open Technical Decisions

| # | Decision | Options | Recommendation |
|---|---|---|---|
| 1 | URL reputation: third-party API vs. internal list | Google Safe Browsing + PhishTank (third-party) vs. self-maintained blocklist | **Third-party** for v1; lower maintenance burden, high quality; migrate to hybrid in v2 |
| 2 | LLM provider for explanation generation | OpenAI GPT-4o-mini vs. Anthropic Claude Haiku vs. self-hosted Llama 3 | **GPT-4o-mini** for v1 (low cost, fast, sufficient quality); evaluate self-hosted for privacy-sensitive deployments |
| 3 | Message content retention for retraining | No retention vs. opt-in consent model | **Opt-in only**, with anonymization pipeline before any human review |
| 4 | Rate limit per API key | 30, 60, 120 req/min | **60 req/min** default with plan-based overrides via API key metadata |

---

## 14. Appendix

### A. Directory Structure

```
scam-detector/
├── api/
│   ├── main.py                  # FastAPI app entry point
│   ├── routes/
│   │   └── analyze.py           # POST /v1/analyze handler
│   └── middleware/
│       └── auth.py              # API key + JWT validation
├── pipeline/
│   ├── orchestrator.py          # asyncio.gather pipeline
│   ├── ingestor.py              # Normalization, URL extraction
│   ├── rule_engine/
│   │   ├── engine.py
│   │   ├── rules.yaml           # Rule definitions
│   │   └── blocklists/          # Domain and number blocklists
│   ├── ml_client.py             # gRPC client for TorchServe
│   ├── url_checker.py           # URL reputation checks
│   ├── channel_analyzer.py      # Channel metadata signals
│   ├── score_merger.py          # Score combination logic
│   ├── explainer.py             # Template + LLM explanation
│   └── recommender.py           # Recommendation catalog engine
├── models/
│   └── schemas.py               # Pydantic request/response models
├── ml/
│   ├── train.py                 # Fine-tuning script
│   ├── evaluate.py              # Evaluation metrics
│   └── torchserve/
│       ├── handler.py           # TorchServe model handler
│       └── config.properties
├── config/
│   ├── recommendations.yaml     # Recommendation catalog
│   └── settings.py              # App settings via pydantic-settings
├── tests/
│   ├── unit/
│   ├── integration/
│   └── fixtures/                # Labeled message fixtures
├── k8s/
│   ├── analysis-service.yaml
│   ├── torchserve.yaml
│   └── redis.yaml
└── Dockerfile
```

### B. Key Dependencies

```
fastapi==0.111.0
uvicorn[standard]==0.30.1
pydantic==2.7.1
orjson==3.10.3
httpx==0.27.0
transformers==4.41.0
torch==2.3.0
shap==0.45.1
redis==5.0.4
aiodns==3.2.0
openai==1.30.1
grpcio==1.64.0
opentelemetry-sdk==1.24.0
```

### C. Proto Definition

```protobuf
syntax = "proto3";
package scamdetector.ml.v1;

service Classifier {
  rpc Classify (ClassifyRequest) returns (ClassifyResponse);
}

message ClassifyRequest {
  string request_id    = 1;
  string text          = 2;
  string channel       = 3;
}

message ClassifyResponse {
  float scam_probability              = 1;
  map<string, float> tag_probabilities = 2;
  repeated TokenAttribution shap_tokens = 3;
  int32 inference_latency_ms          = 4;
}

message TokenAttribution {
  string token = 1;
  float  shap_value = 2;
}
```
