.PHONY: dev test check build

PYTHON ?= python3

# Run local Go API server and Vite frontend dev server together (Ctrl-C stops both)
dev:
	@trap 'kill 0' INT TERM EXIT; \
	(cd backend && go run ./cmd/dokitool serve -listen 127.0.0.1:8081) & \
	(cd frontend && DEV_API_TARGET=http://127.0.0.1:8081 npm run dev) & \
	wait

# Full unit & contract test suite: Go (-race), frontend unit tests, Python scripts/agent/smoke tests
test:
	cd backend && go test -race -count=1 ./...
	cd frontend && npm test
	$(PYTHON) -B -m unittest discover -s scripts/tests -p 'test_*.py'
	$(PYTHON) -B -m unittest discover -s tools/dokitool-agent/tests -p 'test_*.py'
	$(PYTHON) -B scripts/prod-smoke/test_smoke.py
	DOKITOOL_STAGE2_SKIP_BROWSER=1 node --test scripts/prod-smoke/test_stage2_browser.mjs

# Static security, hygiene, SSOT, supply-chain, OpenAPI/Schema, vet, and typecheck gates
check:
	$(PYTHON) -B scripts/check-public-files.py
	$(PYTHON) -B scripts/check-ssot-consistency.py
	$(PYTHON) -B scripts/check-upstream-updates.py --check-local-pins
	$(PYTHON) -B scripts/check-supply-chain.py --offline
	@if $(PYTHON) -c "import jsonschema" 2>/dev/null; then \
		$(PYTHON) -B scripts/test-unified-schema.py && \
		$(PYTHON) -B scripts/check-openapi.py --require-jsonschema; \
	else \
		echo "Note: jsonschema not installed; running structural OpenAPI check only (install jsonschema for full Draft 2020-12 schema validation)"; \
		$(PYTHON) -B scripts/check-openapi.py; \
	fi
	cd backend && go vet ./... && go run ./cmd/genstatstypes -check -out ../frontend/src/monitor/statsTypes.generated.ts
	cd frontend && npm run typecheck

# Production build: Go binaries, frontend static bundle, Chrome MV3 extension ZIP, and load budget check
build:
	mkdir -p dist
	cd backend && go build -trimpath -o ../dist/dokitool ./cmd/dokitool && go build -trimpath -o ../dist/shanghai-resolver ./cmd/shanghai-resolver
	cd frontend && VITE_API_BASE_URL='' npm run build && npm run check:load-budget
