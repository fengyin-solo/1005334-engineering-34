#!/usr/bin/env node
/**
 * 定稿前检查流水线：依赖校验 → 类型检查 → 构建。
 *
 * - 任一阶段失败即挡下定稿：报告里列出出错的文件和缺失的依赖，退出码非 0。
 * - 回滚策略：构建前把现有 dist 备份到 .pipeline/rollback/dist，构建失败自动恢复；
 *   事后也可用 `node scripts/finalization-pipeline.mjs rollback` 手动回滚到上一版产物。
 * - 断点续跑：阶段状态与输入指纹写在 .pipeline/state.json，中断后重跑只补没跑完的阶段，
 *   已通过且输入未变的阶段直接跳过；`--force` 强制全量重跑，`clean` 清掉状态。
 * - 反复装载不产生重复产物：依赖用 `npm ci`（先清 node_modules 再按锁文件装），
 *   构建由 vite 先清空 dist 再产出（emptyOutDir）。
 * - 留档：每次运行把报告写进 pipeline-reports/（JSON + Markdown），并同步
 *   frontend/public/pipeline-status.json 供简报页面读取，作为定稿闸口。
 *
 * 路径全部相对仓库根（由本脚本位置推导），在任意目录下执行都可以。
 */
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const FRONTEND = join(ROOT, 'frontend')
const SRC_DIR = join(FRONTEND, 'src')
const DIST_DIR = join(FRONTEND, 'dist')
const STATE_DIR = join(ROOT, '.pipeline')
const STATE_FILE = join(STATE_DIR, 'state.json')
const ROLLBACK_DIR = join(STATE_DIR, 'rollback')
const DIST_BACKUP = join(ROLLBACK_DIR, 'dist')
const REPORT_DIR = join(ROOT, 'pipeline-reports')
const STATUS_FILE = join(FRONTEND, 'public', 'pipeline-status.json')

const NPM = process.platform === 'win32' ? 'npm.cmd' : 'npm'
const ROLLBACK_HINT =
  '构建失败已自动恢复上一版 dist；手动回滚执行 make rollback（恢复 .pipeline/rollback/dist），简报数据侧用「退回修改」动作回退。'

// ---------- 小工具 ----------

function log(message) {
  console.log(`[pipeline] ${message}`)
}

function run(command, args, cwd) {
  const started = Date.now()
  const proc = spawnSync(command, args, { cwd, encoding: 'utf8' })
  return {
    code: proc.status ?? 1,
    output: `${proc.stdout ?? ''}${proc.stderr ?? ''}`,
    durationMs: Date.now() - started,
  }
}

function tail(text, lines = 30) {
  const all = text.trim().split('\n')
  return all.slice(Math.max(0, all.length - lines)).join('\n')
}

/** 递归列出目录下所有文件（跳过 node_modules / dist / .git 这类目录）。 */
function walk(dir, skip = new Set()) {
  if (!existsSync(dir)) return []
  const files = []
  for (const entry of readdirSync(dir)) {
    if (skip.has(entry)) continue
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) {
      files.push(...walk(full, skip))
    } else {
      files.push(full)
    }
  }
  return files.sort()
}

/** 对一组文件的路径 + 内容算指纹，输入变了指纹就变。 */
function fingerprintFiles(files) {
  const hash = createHash('sha256')
  for (const file of files) {
    hash.update(relative(ROOT, file))
    hash.update(readFileSync(file))
  }
  return hash.digest('hex')
}

function loadState() {
  try {
    return JSON.parse(readFileSync(STATE_FILE, 'utf8'))
  } catch {
    return { stages: {} }
  }
}

/** 原子写状态：先写临时文件再改名，中断不会留下半个 JSON。 */
function saveState(state) {
  mkdirSync(STATE_DIR, { recursive: true })
  const tmp = `${STATE_FILE}.tmp`
  writeFileSync(tmp, JSON.stringify(state, null, 2))
  renameSync(tmp, STATE_FILE)
}

function gitCommit() {
  const proc = run('git', ['rev-parse', '--short', 'HEAD'], ROOT)
  return proc.code === 0 ? proc.output.trim() : 'unknown'
}

// ---------- 依赖校验 ----------

/** 扫描源码里的裸导入，找出没有写进 package.json 的依赖。 */
function scanUndeclaredDeps() {
  const pkg = JSON.parse(readFileSync(join(FRONTEND, 'package.json'), 'utf8'))
  const declared = new Set([
    ...Object.keys(pkg.dependencies ?? {}),
    ...Object.keys(pkg.devDependencies ?? {}),
  ])
  const files = [
    ...walk(SRC_DIR).filter((file) => /\.(ts|vue)$/.test(file)),
    join(FRONTEND, 'vite.config.ts'),
  ]
  const importRe =
    /(?:import|export)[^'"]*?from\s*['"]([^'"]+)['"]|import\s*\(\s*['"]([^'"]+)['"]\s*\)|import\s*['"]([^'"]+)['"]/g
  const missing = new Map()
  for (const file of files) {
    const text = readFileSync(file, 'utf8')
    for (const match of text.matchAll(importRe)) {
      const spec = match[1] ?? match[2] ?? match[3]
      if (!spec) continue
      if (spec.startsWith('.') || spec.startsWith('/') || spec.startsWith('@/')) continue
      if (spec.startsWith('node:')) continue
      const name = spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0]
      if (!declared.has(name)) {
        if (!missing.has(name)) missing.set(name, new Set())
        missing.get(name).add(relative(FRONTEND, file))
      }
    }
  }
  return [...missing.entries()].map(([name, usedBy]) => ({
    name,
    usedBy: [...usedBy].sort(),
  }))
}

/** 用 npm ls 校验 node_modules 与锁文件是否吻合，收集缺失/版本不符的依赖。 */
function auditInstalledDeps() {
  const proc = run(NPM, ['ls', '--depth=0', '--json'], FRONTEND)
  let parsed = {}
  try {
    parsed = JSON.parse(proc.output)
  } catch {
    // npm ls 退出码非 0 时仍会输出 JSON；解析不了就按原始输出兜底
    return proc.code === 0 ? [] : [{ name: 'npm ls 输出无法解析', usedBy: [tail(proc.output, 5)] }]
  }
  const problems = Array.isArray(parsed.problems) ? parsed.problems : []
  return problems
    .filter((problem) => /missing|invalid|extraneous/i.test(String(problem)))
    .map((problem) => ({ name: String(problem), usedBy: ['npm ls'] }))
}

// ---------- 类型检查 ----------

/** 从 vue-tsc / tsc 输出里提取出错的文件（兼容 file:line:col 与 file(line,col) 两种格式）。 */
function parseErrorFiles(output) {
  const files = new Set()
  for (const line of output.split('\n')) {
    const match = line.match(/^(.+?)\(\d+,\d+\): error TS\d+/) ?? line.match(/^(.+?):\d+:\d+ - error TS\d+/)
    if (match) {
      files.add(match[1].trim())
    }
  }
  return [...files].sort()
}

// ---------- 阶段定义 ----------

const stages = [
  {
    name: 'deps',
    label: '依赖装载与校验',
    fingerprint() {
      return fingerprintFiles([join(FRONTEND, 'package.json'), join(FRONTEND, 'package-lock.json')])
    },
    mustRun() {
      return !existsSync(join(FRONTEND, 'node_modules'))
    },
    run() {
      if (!existsSync(join(FRONTEND, 'package-lock.json'))) {
        return {
          ok: false,
          detail: '缺少 frontend/package-lock.json：先在 frontend 下执行 npm install 生成锁文件并提交，干净克隆才能按锁文件复现装载。',
          missingDeps: [],
        }
      }
      log('npm ci：按锁文件清装 node_modules（反复装载产物一致）')
      const install = run(NPM, ['ci'], FRONTEND)
      if (install.code !== 0) {
        return { ok: false, detail: `npm ci 失败：\n${tail(install.output)}`, missingDeps: [] }
      }
      const missingDeps = auditInstalledDeps()
      if (missingDeps.length > 0) {
        return {
          ok: false,
          detail: `node_modules 与锁文件不吻合，${missingDeps.length} 项依赖缺失/失效`,
          missingDeps,
        }
      }
      return { ok: true, detail: 'node_modules 与锁文件一致', missingDeps: [] }
    },
  },
  {
    name: 'depcheck',
    label: '依赖声明检查',
    fingerprint() {
      return fingerprintFiles([
        ...walk(SRC_DIR),
        join(FRONTEND, 'vite.config.ts'),
        join(FRONTEND, 'package.json'),
      ])
    },
    mustRun() {
      return false
    },
    run() {
      const missingDeps = scanUndeclaredDeps()
      if (missingDeps.length > 0) {
        return {
          ok: false,
          detail: `源码引用了 ${missingDeps.length} 个未声明的依赖`,
          missingDeps,
        }
      }
      return { ok: true, detail: '源码导入均已写进 package.json', missingDeps: [] }
    },
  },
  {
    name: 'typecheck',
    label: '类型检查',
    fingerprint() {
      return fingerprintFiles([
        ...walk(SRC_DIR),
        join(FRONTEND, 'tsconfig.json'),
        join(FRONTEND, 'package-lock.json'),
      ])
    },
    mustRun() {
      return false
    },
    run() {
      const proc = run(NPM, ['run', 'typecheck'], FRONTEND)
      const errorFiles = parseErrorFiles(proc.output)
      if (proc.code !== 0) {
        return {
          ok: false,
          detail: `vue-tsc 报错，涉及 ${errorFiles.length} 个文件：\n${tail(proc.output)}`,
          errorFiles,
        }
      }
      return { ok: true, detail: 'vue-tsc --noEmit 通过', errorFiles: [] }
    },
  },
  {
    name: 'build',
    label: '构建',
    fingerprint() {
      return fingerprintFiles([
        ...walk(SRC_DIR),
        ...walk(join(FRONTEND, 'public'), new Set(['pipeline-status.json'])),
        join(FRONTEND, 'index.html'),
        join(FRONTEND, 'vite.config.ts'),
        join(FRONTEND, 'package-lock.json'),
      ])
    },
    mustRun() {
      return !existsSync(DIST_DIR)
    },
    run() {
      // 回滚策略：构建前把现有产物挪到备份目录，失败就放回去。
      let backedUp = false
      if (existsSync(DIST_DIR)) {
        rmSync(DIST_BACKUP, { recursive: true, force: true })
        mkdirSync(ROLLBACK_DIR, { recursive: true })
        renameSync(DIST_DIR, DIST_BACKUP)
        backedUp = true
        log(`已备份上一版产物到 ${relative(ROOT, DIST_BACKUP)}`)
      }
      const proc = run(NPM, ['run', 'build:app'], FRONTEND)
      if (proc.code !== 0) {
        rmSync(DIST_DIR, { recursive: true, force: true })
        if (backedUp) {
          renameSync(DIST_BACKUP, DIST_DIR)
          log('构建失败，已自动回滚到上一版 dist')
        }
        return {
          ok: false,
          detail: `vite build 失败：\n${tail(proc.output)}`,
          rolledBack: backedUp,
        }
      }
      return { ok: true, detail: 'vite build 通过，产物在 frontend/dist', rolledBack: false }
    },
  },
]

// ---------- 报告与留档 ----------

function writeReports(report) {
  mkdirSync(REPORT_DIR, { recursive: true })
  const jsonPath = join(REPORT_DIR, `${report.runId}.json`)
  const mdPath = join(REPORT_DIR, `${report.runId}.md`)
  writeFileSync(jsonPath, JSON.stringify(report, null, 2))
  writeFileSync(join(REPORT_DIR, 'latest.json'), JSON.stringify(report, null, 2))

  const lines = [
    `# 定稿前检查报告 ${report.runId}`,
    '',
    `- 结果：${report.result === 'passed' ? '✅ 通过，可以定稿' : '❌ 未通过，定稿已挡下'}`,
    `- 提交：${report.gitCommit}`,
    `- 开始：${report.startedAt}`,
    `- 结束：${report.finishedAt}`,
    '',
    '## 阶段',
    '',
    '| 阶段 | 结果 | 耗时 | 说明 |',
    '| --- | --- | --- | --- |',
    ...report.stages.map(
      (stage) => `| ${stage.label} | ${stage.status} | ${stage.durationMs}ms | ${stage.detailSummary} |`,
    ),
    '',
    '## 出错文件',
    '',
    ...(report.errorFiles.length > 0
      ? report.errorFiles.map((file) => `- ${file}`)
      : ['- 无']),
    '',
    '## 缺失依赖',
    '',
    ...(report.missingDeps.length > 0
      ? report.missingDeps.map((dep) => `- ${dep.name}${dep.usedBy.length > 0 ? `（${dep.usedBy.join('、')}）` : ''}`)
      : ['- 无']),
    '',
    '## 回滚策略',
    '',
    `- ${ROLLBACK_HINT}`,
    `- 本次构建前备份：${report.rollback.backup}（${report.rollback.performed ? '构建失败，已自动恢复' : '未触发恢复'}）`,
    '',
  ]
  writeFileSync(mdPath, lines.join('\n'))

  // 页面定稿闸口读这份：简报页据此放行或挡下「确认定稿」。
  mkdirSync(dirname(STATUS_FILE), { recursive: true })
  writeFileSync(
    STATUS_FILE,
    JSON.stringify(
      {
        result: report.result,
        finishedAt: report.finishedAt,
        failedStage: report.failedStage,
        errorFiles: report.errorFiles,
        missingDeps: report.missingDeps.map((dep) => dep.name),
        rollbackHint: ROLLBACK_HINT,
        report: `pipeline-reports/${report.runId}.md`,
      },
      null,
      2,
    ),
  )
  log(`报告已归档：${relative(ROOT, mdPath)}`)
}

// ---------- 命令 ----------

function commandRollback() {
  if (!existsSync(DIST_BACKUP)) {
    log('没有可回滚的备份（.pipeline/rollback/dist 不存在）')
    return 1
  }
  rmSync(DIST_DIR, { recursive: true, force: true })
  renameSync(DIST_BACKUP, DIST_DIR)
  log(`已回滚：${relative(ROOT, DIST_BACKUP)} → ${relative(ROOT, DIST_DIR)}`)
  return 0
}

function commandClean() {
  rmSync(STATE_DIR, { recursive: true, force: true })
  log('已清掉流水线状态与回滚备份（.pipeline/），下次运行全量重跑')
  return 0
}

function commandRun(force) {
  const state = loadState()
  const startedAt = new Date()
  const runId = startedAt.toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19)
  const report = {
    runId,
    result: 'passed',
    gitCommit: gitCommit(),
    startedAt: startedAt.toISOString(),
    finishedAt: '',
    failedStage: null,
    stages: [],
    errorFiles: [],
    missingDeps: [],
    rollback: { backup: relative(ROOT, DIST_BACKUP), performed: false },
  }

  log(`定稿前检查开始（${runId}），仓库根：${ROOT}`)
  for (const stage of stages) {
    const fingerprint = stage.fingerprint()
    const prev = state.stages?.[stage.name]
    const reusable = prev?.status === 'passed' && prev.fingerprint === fingerprint && !stage.mustRun()
    if (!force && reusable) {
      log(`跳过 ${stage.label}：已通过且输入未变`)
      report.stages.push({ name: stage.name, label: stage.label, status: 'skipped', durationMs: 0, detailSummary: '已通过（断点续跑跳过）' })
      continue
    }
    log(`开始 ${stage.label}…`)
    const started = Date.now()
    const result = stage.run()
    const durationMs = Date.now() - started
    state.stages = state.stages ?? {}
    state.stages[stage.name] = {
      status: result.ok ? 'passed' : 'failed',
      fingerprint,
      finishedAt: new Date().toISOString(),
      durationMs,
    }
    saveState(state)

    report.stages.push({
      name: stage.name,
      label: stage.label,
      status: result.ok ? 'passed' : 'failed',
      durationMs,
      detailSummary: result.ok ? result.detail.split('\n')[0] : '失败，详见 JSON 报告',
      detail: result.detail,
    })
    if (result.errorFiles) report.errorFiles.push(...result.errorFiles)
    if (result.missingDeps) report.missingDeps.push(...result.missingDeps)
    if (result.rolledBack) report.rollback.performed = true

    if (!result.ok) {
      report.result = 'failed'
      report.failedStage = stage.name
      log(`✗ ${stage.label}失败，定稿已挡下`)
      break
    }
    log(`✓ ${stage.label}通过（${durationMs}ms）`)
  }

  report.finishedAt = new Date().toISOString()
  writeReports(report)

  if (report.result === 'failed') {
    if (report.errorFiles.length > 0) {
      log(`出错文件：\n  ${report.errorFiles.join('\n  ')}`)
    }
    if (report.missingDeps.length > 0) {
      log(`缺失依赖：\n  ${report.missingDeps.map((dep) => dep.name).join('\n  ')}`)
    }
    log(`回滚策略：${ROLLBACK_HINT}`)
    return 1
  }
  log('定稿前检查全部通过，可以定稿')
  return 0
}

// ---------- 入口 ----------

const args = process.argv.slice(2)
const command = args.find((arg) => !arg.startsWith('-')) ?? 'run'
const force = args.includes('--force') || args.includes('-f')

let exitCode
if (command === 'rollback') {
  exitCode = commandRollback()
} else if (command === 'clean') {
  exitCode = commandClean()
} else {
  exitCode = commandRun(force)
}
process.exit(exitCode)
