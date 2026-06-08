.PHONY: install lint typecheck test test-unit test-integration run dev clean

# ── Setup ─────────────────────────────────────────────────────────────────────
install:
	pip install -e ".[dev]"

# ── Quality ───────────────────────────────────────────────────────────────────
lint:
	ruff check .

lint-fix:
	ruff check . --fix

typecheck:
	mypy api pipeline models config --ignore-missing-imports

audit:
	pip-audit --strict

# ── Tests ─────────────────────────────────────────────────────────────────────
test:
	pytest tests/ -v --cov=. --cov-report=term-missing

test-unit:
	pytest tests/unit -v --cov=. --cov-report=term-missing --cov-fail-under=80

test-integration:
	pytest tests/integration -v

# ── Run ───────────────────────────────────────────────────────────────────────
run:
	uvicorn api.main:app --host 0.0.0.0 --port 8000 --reload

# ── Protobuf ─────────────────────────────────────────────────────────────────
proto:
	python -m grpc_tools.protoc \
		-I ml/torchserve \
		--python_out=ml/torchserve \
		--grpc_python_out=ml/torchserve \
		ml/torchserve/scam_classifier.proto

# ── Blocklists ────────────────────────────────────────────────────────────────
refresh-blocklists:
	python scripts/refresh_blocklists.py

# ── Smoke test ────────────────────────────────────────────────────────────────
smoke:
	python scripts/smoke_test.py

# ── Clean ─────────────────────────────────────────────────────────────────────
clean:
	find . -type d -name __pycache__ -exec rm -rf {} + 2>/dev/null; \
	find . -name "*.pyc" -delete; \
	rm -rf .mypy_cache .ruff_cache .pytest_cache htmlcov .coverage
