.PHONY: help install frontend build gate gate-deps gate-typecheck gate-build gate-reset rollback clean-clone test-app-gate verify

help: ## 显示可用目标
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*?## "}; {printf "  %-16s %s\n", $$1, $$2}'

install: ## 按 lockfile 安装前端依赖
	cd frontend && npm ci --no-audit --no-fund || npm install --no-audit --no-fund

frontend: ## 本地开发服务器
	cd frontend && npm run dev

build: gate ## 生产构建（先过定稿闸门，失败即挡下）

gate: ## 定稿前检查流水线：依赖安装 → 依赖校验 → 类型检查 → 构建（可续跑）
	node scripts/release-gate.mjs

gate-deps: ## 只跑到依赖校验
	node scripts/release-gate.mjs --stage deps

gate-typecheck: ## 只跑到类型检查
	node scripts/release-gate.mjs --stage typecheck

gate-build: ## 只跑到构建
	node scripts/release-gate.mjs --stage build

gate-reset: ## 清空闸门续跑状态，下次从头检查
	node scripts/release-gate.mjs --reset

rollback: ## 回滚到最近一次通过闸门的构建产物
	node scripts/rollback-release.mjs

clean-clone: ## 干净克隆演练：克隆 → 装依赖 → 闸门 → 构建（临时目录）
	bash scripts/verify-clean-clone.sh

test-app-gate: ## 应用内定稿闸门冒烟测试（拦截/放行/验收待办/幂等）
	node scripts/probe-app-gate.mjs

verify: gate test-app-gate ## 全量校验：发布闸门 + 应用侧闸门冒烟

