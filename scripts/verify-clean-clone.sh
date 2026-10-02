#!/usr/bin/env bash
# 干净克隆演练：验证「从零克隆 → 装依赖 → 定稿闸门 → 构建」全流程能跑通。
# 不依赖 /workspace 这类固定路径，目标目录通过参数或 mktemp 给出。
#
# 用法：
#   scripts/verify-clean-clone.sh              # 用 mktemp -d 生成临时目录
#   scripts/verify-clean-clone.sh /tmp/xxx     # 指定克隆目标目录
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

TARGET="${1:-}"
if [[ -z "${TARGET}" ]]; then
  TARGET="$(mktemp -d)"
  CREATED=1
else
  CREATED=0
  mkdir -p "${TARGET}"
fi
CLONE_DIR="${TARGET}/clone"

echo "━━━ 干净克隆演练 ━━━"
echo "源仓库  : ${REPO_ROOT}"
echo "目标目录: ${CLONE_DIR}"

# 1) 克隆已提交的历史，再把当前工作树叠上去，模拟「这些改动提交后被重新克隆」。
#    不带入 node_modules / dist / 闸门状态，保证对方从零装起。
git clone --no-hardlinks "file://${REPO_ROOT}" "${CLONE_DIR}"
tar -C "${REPO_ROOT}" \
  --exclude='./.git' \
  --exclude='*/node_modules' \
  --exclude='./frontend/dist' \
  --exclude='./.release-gate' \
  -cf - . | tar -C "${CLONE_DIR}" -xf -

cd "${CLONE_DIR}"

echo "── 1/3 安装依赖（npm ci，严格按 lockfile）──"
( cd frontend && npm ci --no-audit --no-fund )

echo "── 2/3 定稿闸门（依赖安装 → 依赖校验 → 类型检查 → 构建）──"
node scripts/release-gate.mjs --force

echo "── 3/3 产物核对 ──"
test -f frontend/dist/index.html
test -d frontend/dist/assets
echo "frontend/dist/index.html 与 frontend/dist/assets 均存在"

echo
echo "演练完成，目录: ${CLONE_DIR}（保留供复查）"
echo "━━━ 干净克隆演练通过 ━━━"
