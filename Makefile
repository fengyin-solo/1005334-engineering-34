.PHONY: install frontend build pipeline pipeline-force clean rollback

install:
	cd frontend && npm install

frontend:
	cd frontend && npm run dev

build:
	cd frontend && npm run build

# 定稿前检查流水线：依赖校验 → 类型检查 → 构建
# 失败即挡下定稿并归档报告；中断后重跑自动续上未完成的阶段
pipeline:
	node scripts/finalization-pipeline.mjs

# 无视断点状态，全量重跑
pipeline-force:
	node scripts/finalization-pipeline.mjs --force

# 清构建缓存与产物（不动流水线状态与回滚备份）
clean:
	rm -rf frontend/dist frontend/node_modules/.vite

# 回滚到上一版构建产物
rollback:
	node scripts/finalization-pipeline.mjs rollback
