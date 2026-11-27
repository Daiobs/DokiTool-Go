.PHONY: dev test check build

PYTHON ?= python3
VERSION ?= $(shell git rev-parse HEAD 2>/dev/null || echo dev)
ALLOW_PARTIAL_SCHEMA ?= 0

DEV_BACKEND_CMD ?= cd backend && go run ./cmd/dokitool serve -listen 127.0.0.1:8081
DEV_FRONTEND_CMD ?= cd frontend && DEV_API_TARGET=http://127.0.0.1:8081 npm run dev
export DEV_BACKEND_CMD
export DEV_FRONTEND_CMD

# Run local Go API server and Vite frontend dev server together.
# Tracks both child PIDs explicitly (never `kill 0`), stops the peer if either exits/fails,
# and performs idempotent descendant-tree cleanup on exit or SIGINT/SIGTERM.
dev:
	@set -u; \
	run_dir="$$(mktemp -d "$${TMPDIR:-/tmp}/dokitool-dev.XXXXXX")"; \
	backend_pid=""; frontend_pid=""; sleep_pid=""; cleaned=0; \
	list_tree() { \
		[ -n "$$1" ] || return 0; \
		ps -eo pid=,ppid= 2>/dev/null | awk -v root="$$1" ' \
			{ children[$$2] = children[$$2] " " $$1 } \
			function walk(p,   n, arr, i) { \
				n = split(children[p], arr, " "); \
				for (i = 1; i <= n; i++) if (arr[i] != "") walk(arr[i]); \
				print p; \
			} \
			END { if (root != "") walk(root); } \
		'; \
	}; \
	is_alive() { \
		[ -n "$$1" ] || return 1; \
		_st=$$(ps -o stat= -p "$$1" 2>/dev/null | tr -d ' '); \
		[ -n "$$_st" ] || return 1; \
		case "$$_st" in Z*) return 1 ;; esac; \
		return 0; \
	}; \
	terminate_pids() { \
		_sig="$$1"; shift; \
		for _root in "$$@"; do \
			[ -n "$$_root" ] || continue; \
			for _p in $$(list_tree "$$_root"); do \
				[ "$$_p" != "$$$$" ] && kill "-$$_sig" "$$_p" 2>/dev/null || true; \
			done; \
		done; \
	}; \
	cleanup() { \
		trap '' INT TERM EXIT; \
		[ "$$cleaned" -eq 1 ] && return 0; \
		cleaned=1; \
		[ -n "$$sleep_pid" ] && kill -TERM "$$sleep_pid" 2>/dev/null || true; \
		terminate_pids TERM "$$backend_pid" "$$frontend_pid"; \
		_i=0; \
		while [ "$$_i" -lt 20 ]; do \
			_alive=0; \
			for _root in "$$backend_pid" "$$frontend_pid"; do \
				[ -n "$$_root" ] || continue; \
				for _p in $$(list_tree "$$_root"); do \
					if is_alive "$$_p"; then _alive=1; break; fi; \
				done; \
				[ "$$_alive" -eq 1 ] && break; \
			done; \
			[ "$$_alive" -eq 0 ] && break; \
			sleep 0.1; \
			_i=$$((_i + 1)); \
		done; \
		terminate_pids KILL "$$backend_pid" "$$frontend_pid"; \
		[ -n "$$backend_pid" ] && wait "$$backend_pid" 2>/dev/null || true; \
		[ -n "$$frontend_pid" ] && wait "$$frontend_pid" 2>/dev/null || true; \
		[ -n "$$sleep_pid" ] && wait "$$sleep_pid" 2>/dev/null || true; \
		rm -rf "$$run_dir"; \
	}; \
	on_signal() { _sig="$$1"; cleanup; if [ "$$_sig" = "INT" ]; then exit 130; else exit 143; fi; }; \
	trap 'on_signal INT' INT; \
	trap 'on_signal TERM' TERM; \
	trap 'cleanup' EXIT; \
	( sh -c "$$DEV_BACKEND_CMD"; _rc=$$?; printf '%s\n' "$$_rc" > "$$run_dir/backend.rc.tmp" && mv "$$run_dir/backend.rc.tmp" "$$run_dir/backend.rc" ) & backend_pid=$$!; \
	( sh -c "$$DEV_FRONTEND_CMD"; _rc=$$?; printf '%s\n' "$$_rc" > "$$run_dir/frontend.rc.tmp" && mv "$$run_dir/frontend.rc.tmp" "$$run_dir/frontend.rc" ) & frontend_pid=$$!; \
	while [ ! -f "$$run_dir/backend.rc" ] && [ ! -f "$$run_dir/frontend.rc" ]; do \
		sleep 0.1 & sleep_pid=$$!; \
		wait "$$sleep_pid" 2>/dev/null || true; \
		sleep_pid=""; \
	done; \
	status=1; \
	if [ -f "$$run_dir/backend.rc" ]; then \
		_rc=$$(cat "$$run_dir/backend.rc" 2>/dev/null || echo 1); \
		if [ "$$_rc" -ne 0 ] 2>/dev/null; then status="$$_rc"; fi; \
	elif [ -f "$$run_dir/frontend.rc" ]; then \
		_rc=$$(cat "$$run_dir/frontend.rc" 2>/dev/null || echo 1); \
		if [ "$$_rc" -ne 0 ] 2>/dev/null; then status="$$_rc"; fi; \
	fi; \
	cleanup; \
	exit "$$status"

# Full unit & contract test suite: Go (-race), frontend unit tests, Python scripts/agent/smoke tests
test:
	cd backend && go test -race -count=1 ./...
	cd frontend && npm test
	$(PYTHON) -B -m unittest discover -s scripts/tests -p 'test_*.py'
	$(PYTHON) -B -m unittest discover -s tools/dokitool-agent/tests -p 'test_*.py'
	$(PYTHON) -B scripts/prod-smoke/test_smoke.py
	DOKITOOL_STAGE2_SKIP_BROWSER=1 node --test scripts/prod-smoke/test_stage2_browser.mjs

# Static security, hygiene, SSOT, supply-chain, OpenAPI/Schema (fail-closed by default), vet, and typecheck gates
check:
	$(PYTHON) -B scripts/check-public-files.py
	$(PYTHON) -B scripts/check-ssot-consistency.py
	$(PYTHON) -B scripts/check-upstream-updates.py --check-local-pins
	$(PYTHON) -B scripts/check-supply-chain.py --offline
	@if $(PYTHON) -c "import jsonschema" 2>/dev/null; then \
		$(PYTHON) -B scripts/test-unified-schema.py && \
		$(PYTHON) -B scripts/check-openapi.py --require-jsonschema; \
	elif [ "$(ALLOW_PARTIAL_SCHEMA)" = "1" ]; then \
		echo "Warning: ALLOW_PARTIAL_SCHEMA=1 set without jsonschema; skipping Draft 2020-12 schema validation" >&2; \
		$(PYTHON) -B scripts/check-openapi.py; \
	else \
		echo "Error: Python package 'jsonschema' is required for full unified-schema & OpenAPI Draft 2020-12 validation." >&2; \
		echo "Install via: $(PYTHON) -m pip install -r scripts/requirements-validation.txt" >&2; \
		echo "Or specify a virtualenv Python: make PYTHON=/path/to/venv/bin/python check" >&2; \
		echo "To explicitly run structural OpenAPI checks only, pass ALLOW_PARTIAL_SCHEMA=1." >&2; \
		exit 1; \
	fi
	cd backend && go vet ./... && go run ./cmd/genstatstypes -check -out ../frontend/src/monitor/statsTypes.generated.ts
	cd frontend && npm run typecheck

# Local host build: Go binaries (with commit SHA injected into main.version), frontend static bundle,
# Chrome MV3 extension ZIP, and load budget check.
# Official Linux release artifacts with SLSA v1 provenance are produced by .github/workflows/release-build.yml.
build:
	mkdir -p dist
	cd backend && go build -trimpath -ldflags "-X main.version=$(VERSION)" -o ../dist/dokitool ./cmd/dokitool && go build -trimpath -ldflags "-X main.version=$(VERSION)" -o ../dist/shanghai-resolver ./cmd/shanghai-resolver
	cd frontend && VITE_API_BASE_URL='' npm run build && npm run check:load-budget
