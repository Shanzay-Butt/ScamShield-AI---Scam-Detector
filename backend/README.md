# AI Scam Detector — Backend

FastAPI service that analyzes WhatsApp, SMS, and email messages for scam risk.

## Quick Start

```bash
# 1. Install dependencies
make install

# 2. Copy and fill in secrets
cp .env.example .env

# 3. Start Redis locally
docker run -d -p 6379:6379 redis:7.2-alpine

# 4. Run the API (dev mode with reload)
make run
```

API is available at `http://localhost:8000`.  
Interactive docs: `http://localhost:8000/docs`

## Project Structure

```
backend/
├── api/               FastAPI app, routes, auth middleware
├── config/            Settings, recommendation catalog YAML
├── models/            Pydantic request/response schemas
├── pipeline/          Analysis pipeline components
│   ├── rule_engine/   Aho-Corasick keyword + regex + blocklists
│   ├── ingestor.py    Text normalization, URL extraction
│   ├── url_checker.py GSB + PhishTank + domain age checks
│   ├── channel_analyzer.py  Channel-specific metadata signals
│   ├── score_merger.py      Weighted score combination
│   ├── explainer.py         Template + LLM explanation
│   ├── recommender.py       Catalog-driven recommendations
│   ├── ml_client.py         gRPC client for TorchServe
│   ├── orchestrator.py      Async pipeline coordinator
│   └── cache.py             Redis wrapper
├── ml/                Model training, evaluation, TorchServe handler
├── tests/
│   ├── unit/          Fast, isolated unit tests
│   ├── integration/   Full API and pipeline integration tests
│   └── fixtures/      Labeled message test fixtures
├── scripts/           Smoke test, blocklist refresh
├── k8s/               Kubernetes manifests
└── docs/runbooks/     Operational runbooks
```

## Key Commands

| Command | Description |
|---|---|
| `make test` | Run all tests with coverage |
| `make test-unit` | Unit tests only (fast) |
| `make test-integration` | Integration tests |
| `make lint` | Ruff linting |
| `make typecheck` | mypy type checking |
| `make proto` | Regenerate gRPC stubs from .proto |
| `make refresh-blocklists` | Fetch updated phishing domain lists |
| `make smoke` | Run smoke test against a live deployment |

## Environment Variables

See `.env.example` for the full list.  
Required secrets: `URL_CHECK_GSB_API_KEY`, `URL_CHECK_PHISHTANK_API_KEY`, `LLM_OPENAI_API_KEY`.

## API

```
POST /v1/analyze
Authorization: X-API-Key <key>  or  Authorization: Bearer <jwt>

{
  "message_body": "Your account will be suspended...",
  "channel": "email",
  "sender": "noreply@suspicious.xyz",
  "subject": "Urgent: verify now",
  "reply_to": "harvest@evil.com"
}
```

See `technical-design.md` for full schema and response examples.
