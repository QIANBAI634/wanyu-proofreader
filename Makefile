# 方辑万语校坊 — one entry point for every check CI runs.
#
# `make check` is the fast, pre-push gate (no Docker, no browsers).
# `make ci` adds the integration suites and image builds that CI also runs.

SHELL := /bin/sh
BACKEND := backend
FRONTEND := frontend
TRAEFIK_HOST ?= fangji.example.com
VERSION ?= $(shell git describe --tags --always --dirty 2>/dev/null)
COMMIT ?= $(shell git rev-parse HEAD 2>/dev/null)
BUILD_DATE ?= $(shell date -u +%Y-%m-%dT%H:%M:%SZ)
SUITES ?=
JOBS ?= 4
# CI diffs against the PR base; a bare `git diff --check` only compares the
# working tree to the index and is clean right after a checkout.
BASE ?= $(shell git merge-base upstream/main HEAD 2>/dev/null || git merge-base origin/main HEAD 2>/dev/null || git rev-parse HEAD~1)

.PHONY: help check lint format test test-go test-node test-integration \
	coverage verify-static verify-migrations verify-compose verify-versions \
	seed build docker-build ci clean-tools

help:
	@printf '%s\n' \
	'make check           所有推送前应跑的门禁（不含 Docker 与浏览器）' \
	'make ci              check + 全部集成套件 + 镜像构建' \
	'make lint            gofmt/go vet 与前端 ESLint' \
	'make format          自动修复前端与 Go 格式' \
	'make test            Go 单测 + 前端单测' \
	'make test-go         Go 单测（RACE=1 启用竞态检测）' \
	'make test-node       前端 node:test 单测' \
	'make test-integration 全部后端集成套件（共享一次编译）' \
	'make coverage        Go 与前端覆盖率报告' \
	'make seed            用演示项目填充本地数据库' \
	'make docker-build    构建前后端镜像'
	@printf '%s\n' ''

# ---------------------------------------------------------------- fast gates

check: verify-static test lint verify-versions verify-migrations verify-compose
	@printf '\ncheck: all gates passed\n'

verify-static:
	@python3 -c 'import yaml' 2>/dev/null || { \
	  echo 'PyYAML is required by the repository guards: python3 -m pip install -r requirements-dev.txt'; exit 1; }
	@echo 'gofmt -l $(BACKEND)'
	@out=$$(cd $(BACKEND) && gofmt -l .); test -z "$$out" || { printf 'not gofmt-clean:\n%s\n' "$$out"; exit 1; }
	@echo 'go vet ./...'
	@cd $(BACKEND) && go vet ./...
	@echo 'test inventory (suites.json vs disk vs ci vs CONTRIBUTING)'
	@cd $(BACKEND)/tests && python3 check_test_inventory.py
	@echo 'guard and tooling self-tests'
	@python3 -m unittest discover -s scripts -p 'test_*.py'
	@python3 -m unittest discover -s ops -p 'test_*.py'
	@echo 'whitespace (committed range, working tree and index)'
	@test -n "$(BASE)" && git diff --check $(BASE) HEAD
	@git diff --check
	@git diff --cached --check
	@echo 'line endings (index holds LF or binary only)'
	@python3 scripts/check_line_endings.py
	@echo 'UI debt ratchet (per-kind warn/fail policy)'
	@python3 scripts/check_ui_debt.py
	@echo 'docker build context (every Go package directory is copied)'
	@python3 scripts/check_docker_build_context.py

lint:
	@echo 'eslint (correctness rules only; no style sweep yet)'
	@npm --prefix $(FRONTEND) run --silent lint

format:
	@cd $(BACKEND) && gofmt -w .
	@npm --prefix $(FRONTEND) run --silent lint:fix

verify-versions:
	@python3 $(BACKEND)/tests/check_runtime_versions.py

verify-compose:
	@set -e; \
	if command -v docker >/dev/null 2>&1; then \
		echo 'docker compose config (6 entry point combinations)'; \
		for config in docker-compose.yml docker-compose.dev.yml docker-compose.traefik.yml; do \
			TRAEFIK_HOST=$(TRAEFIK_HOST) docker compose -f $$config config --quiet; \
			TRAEFIK_HOST=$(TRAEFIK_HOST) docker compose -f $$config -f docker-compose.named-volume.yml config --quiet; \
		done; \
	else \
		echo 'SKIP docker compose config: docker is not installed (CI runs these assertions)'; \
	fi
	@python3 scripts/check_compose_structure.py

# ---------------------------------------------------------------- tests

test: test-go test-node

test-go:
	@if [ -n "$(RACE)" ]; then cd $(BACKEND) && go test -race ./...; else cd $(BACKEND) && go test ./...; fi

test-node:
	@npm --prefix $(FRONTEND) test

test-integration:
	@cd $(BACKEND)/tests && python3 run_all.py --jobs $(JOBS) $(SUITES)

verify-migrations:
	@python3 $(BACKEND)/tests/check_migrations.py
	@python3 -m unittest discover -s $(BACKEND)/tests -p 'test_*.py'

coverage:
	@cd $(BACKEND) && go test -coverprofile=coverage.out ./... && go tool cover -func=coverage.out | tail -1
	@cd $(BACKEND) && go tool cover -html=coverage.out -o coverage.html && printf 'wrote %s\n' $(BACKEND)/coverage.html
	@npm --prefix $(FRONTEND) run --silent test:coverage

# ---------------------------------------------------------------- local data

seed:
	@node $(BACKEND)/tests/seed_demo.mjs

# ---------------------------------------------------------------- heavier

build:
	@npm --prefix $(FRONTEND) ci && npm --prefix $(FRONTEND) run build

docker-build:
	@docker build -t fangji-backend:ci --build-arg VERSION=$(VERSION) \
	  --build-arg COMMIT=$(COMMIT) --build-arg BUILD_DATE=$(BUILD_DATE) $(BACKEND)
	@docker build -t fangji-frontend:ci $(FRONTEND)

ci: check test-integration build docker-build
	@printf '\nci: all jobs passed\n'

clean-tools:
	@rm -f $(BACKEND)/coverage.out $(BACKEND)/coverage.html
