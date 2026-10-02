#!/usr/bin/env node
/**
 * 定稿/发布回滚：把最近一次通过闸门时留档的产物快照恢复到 frontend/dist，
 * 并清掉闸门续跑标记，使下一次发布重新走完整检查。
 *
 * 用法：
 *   node scripts/rollback-release.mjs          # 回滚到最近一次通过的构建
 *   node scripts/rollback-release.mjs --keep-state  # 只回滚产物，保留闸门状态
 */

import { existsSync, mkdirSync, readdirSync, cpSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(SCRIPT_DIR, '..')
const SNAPSHOT_DIR = join(REPO_ROOT, '.release-gate', 'snapshots', 'last-release')
const DIST_DIR = join(REPO_ROOT, 'frontend', 'dist')
const STATE_DIR = join(REPO_ROOT, '.release-gate', 'state')
const keepState = process.argv.includes('--keep-state')

const useColor = process.stdout.isTTY
const paint = (code, text) => (useColor ? `[${code}m${text}[0m` : text)
const ok = (text) => console.log(paint(32, text))
const bad = (text) => console.log(paint(31, text))
const info = (text) => console.log(paint(36, text))

info('━━━ 发布回滚 ━━━')
if (!existsSync(SNAPSHOT_DIR) || readdirSync(SNAPSHOT_DIR).length === 0) {
  bad('没有可用的回滚快照（.release-gate/snapshots/last-release 为空）')
  bad('请改用 git：git revert <定稿提交> 或 git reset --hard <上一个定稿标签>')
  process.exit(1)
}

rmSync(DIST_DIR, { recursive: true, force: true })
mkdirSync(DIST_DIR, { recursive: true })
cpSync(SNAPSHOT_DIR, DIST_DIR, { recursive: true })
ok(`已将 frontend/dist 恢复为最近一次通过闸门的构建产物（${readdirSync(DIST_DIR).length} 个顶层条目）`)

if (!keepState) {
  rmSync(STATE_DIR, { recursive: true, force: true })
  ok('已清空闸门续跑状态，重新发布会从依赖校验开始完整检查')
}

info('后续步骤：')
info('1. 用回滚后的 dist 重新部署（例如重新构建镜像或回传静态目录）')
info('2. 如需连代码一起回退：git revert <定稿提交>（保留历史）或 git tag 定位后 reset')
info('3. 问题修复后重跑：node scripts/release-gate.mjs')
