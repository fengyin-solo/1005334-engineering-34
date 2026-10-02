#!/usr/bin/env node
/**
 * 定稿闸门：发掘简报定稿（发布）前必须跑完的检查流水线。
 *
 * 顺序四个阶段，前一个不过就挡下后面的：
 *   install  -> deps -> typecheck -> build
 *   装依赖     依赖校验   类型检查       生产构建
 *
 * 特性：
 * - 断点续跑：每个阶段成功后按「输入指纹」落标记；重跑时输入没变就跳过，
 *   中断/失败后再跑只补没跑完的阶段，已经通过的不再重跑。
 * - 构建幂等：build 阶段先清空 dist 再构建，连续构建两次比对清单，
 *   保证缓存清理后反复装载不会产生重复产物。
 * - 失败可读：缺的依赖、出错的文件分别汇总到终端与留档报告。
 * - 路径不写死：所有路径都相对本脚本所在的仓库根目录解析。
 *
 * 用法：
 *   node scripts/release-gate.mjs                # 顺序跑到 build（定稿门禁）
 *   node scripts/release-gate.mjs --stage deps   # 只补跑到指定阶段
 *   node scripts/release-gate.mjs --force        # 忽略标记全部重跑
 *   node scripts/release-gate.mjs --reset        # 只清流水线状态，不跑
 */

import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// ---- 路径：永远从脚本位置推导，换克隆目录、换机器都不用改 ----
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(SCRIPT_DIR, '..')
const FRONTEND_DIR = join(REPO_ROOT, 'frontend')
const SRC_DIR = join(FRONTEND_DIR, 'src')
const STATE_DIR = join(REPO_ROOT, '.release-gate', 'state') // 续跑标记（gitignore）
const RUNS_DIR = join(REPO_ROOT, '.release-gate', 'runs') // 结构化留档（gitignore）
const RECORDS_DIR = join(REPO_ROOT, 'release-records') // 入档报告（随仓库留存）
const SNAPSHOT_DIR = join(REPO_ROOT, '.release-gate', 'snapshots', 'last-release') // 上次发布产物，供回滚
const MARKER_FILE = join(STATE_DIR, 'markers.json')
const PKG_FILE = join(FRONTEND_DIR, 'package.json')
const LOCK_FILE = join(FRONTEND_DIR, 'package-lock.json')
const DIST_DIR = join(FRONTEND_DIR, 'dist')

const STAGES = ['install', 'deps', 'typecheck', 'build']

// ---- 终端输出 ----
const useColor = process.stdout.isTTY
const paint = (code, text) => (useColor ? `[${code}m${text}[0m` : text)
const ok = (text) => paint(32, text)
const warn = (text) => paint(33, text)
const bad = (text) => paint(31, text)
const info = (text) => paint(36, text)
const dim = (text) => paint(90, text)
function log(line) {
  console.log(line)
}

// ---- 基础工具 ----
function sha1(value) {
  return createHash('sha1').update(value).digest('hex')
}

function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'))
}

function listFiles(dir, extList) {
  const out = []
  if (!existsSync(dir)) {
    return out
  }
  for (const name of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, name.name)
    if (name.isDirectory()) {
      out.push(...listFiles(full, extList))
    } else if (extList.some((ext) => name.name.endsWith(ext))) {
      out.push(full)
    }
  }
  return out
}

function hashFiles(files) {
  const hash = createHash('sha1')
  for (const file of files.sort()) {
    hash.update(relative(REPO_ROOT, file).replaceAll('\\\\', '/'))
    hash.write(readFileSync(file))
  }
  return hash.digest('hex')
}

function runCommand(cmd, args, cwd) {
  const res = spawnSync(cmd, args, { cwd, encoding: 'utf8' })
  return {
    status: res.status ?? (res.error ? 1 : 0),
    stdout: res.stdout ?? '',
    stderr: res.stderr ?? (res.error ? String(res.error.message) : ''),
  }
}

function writeJsonAtomic(file, value) {
  mkdirSync(dirname(file), { recursive: true })
  const tmp = `${file}.tmp`
  writeFileSync(tmp, JSON.stringify(value, null, 2))
  cpSync(tmp, file)
  rmSync(tmp, { force: true })
}

// ---- 续跑标记 ----
function loadMarkers() {
  try {
    return readJson(MARKER_FILE)
  } catch {
    return {}
  }
}

function saveMarkers(markers) {
  writeJsonAtomic(MARKER_FILE, markers)
}

// ---- 各阶段指纹：输入内容变了，标记就失效 ----
function fingerprint(stage) {
  const hash = createHash('sha1')
  hash.update(`stage:${stage}\n`)
  hash.update(`node:${process.version}\n`)
  if (existsSync(PKG_FILE)) {
    hash.update(readFileSync(PKG_FILE))
  }
  if (existsSync(LOCK_FILE)) {
    hash.update(readFileSync(LOCK_FILE))
  }
  if (stage === 'install') {
    // node_modules 没了（缓存清理/换机器）就必须重装修，不能拿旧标记跳过
    const installedLock = join(FRONTEND_DIR, 'node_modules', '.package-lock.json')
    hash.update(existsSync(installedLock) ? readFileSync(installedLock) : 'node_modules:absent')
  }
  if (stage === 'deps' || stage === 'typecheck' || stage === 'build') {
    // deps 也要扫源码 import；typecheck/build 更不用说，源码变了都得重跑
    hash.update(hashFiles(listFiles(SRC_DIR, ['.ts', '.vue', '.js', '.css'])))
    for (const extra of ['tsconfig.json', 'vite.config.ts', 'index.html', '.env.production']) {
      const file = join(FRONTEND_DIR, extra)
      if (existsSync(file)) {
        hash.update(readFileSync(file))
      }
    }
  }
  if (stage === 'build') {
    hash.update('build-v2') // 调整构建口径时抬版本，强制重建
  }
  return hash.digest('hex')
}

// ---- 阶段 1：安装依赖（干净克隆也要能跑通，所以缺 node_modules 时自动 npm ci）----
function stageInstall() {
  if (!existsSync(LOCK_FILE)) {
    return {
      ok: false,
      errors: [{ file: 'frontend/package-lock.json', message: '缺少 package-lock.json，无法做可复现安装（npm ci 必须有锁文件）' }],
      logs: [],
    }
  }
  if (!existsSync(join(FRONTEND_DIR, 'node_modules'))) {
    log(dim('  node_modules 不存在，执行 npm ci 安装依赖…'))
    const res = runCommand('npm', ['ci', '--no-audit', '--no-fund'], FRONTEND_DIR)
    if (res.status !== 0) {
      return {
        ok: false,
        errors: [{ file: 'frontend/package.json', message: 'npm ci 安装失败，中断后再次执行会从这一段继续' }],
        logs: [res.stdout, res.stderr].filter(Boolean).join('\n').trim().split('\n').slice(-30),
      }
    }
  }
  return { ok: true, errors: [], logs: [] }
}

// 从源码里扫 import，找出「用了但 package.json 没声明」的依赖
const BARE_SPEC_RE =
  /(?:import\s+(?:[^'"]*?\s+from\s+)?|export\s+[^'"]*?\s+from\s+|require\s*\()\s*['"]([^'"]+)['"]/g
const BUILTIN_MODULES = new Set([
  'fs', 'path', 'os', 'crypto', 'child_process', 'url', 'node:url', 'node:fs',
])
function packageNameOf(spec) {
  if (spec.startsWith('.') || spec.startsWith('/') || spec.startsWith('@/') || spec.startsWith('#')) {
    return null
  }
  if (spec.startsWith('node:')) {
    return null
  }
  if (BUILTIN_MODULES.has(spec.split('/')[0])) {
    return null
  }
  return spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0]
}

// ---- 阶段 2：依赖校验 ----
function stageDeps() {
  const pkg = readJson(PKG_FILE)
  const declared = new Set([
    ...Object.keys(pkg.dependencies ?? {}),
    ...Object.keys(pkg.devDependencies ?? {}),
  ])

  // npm ls：装了但对不上锁文件 / 缺失的包会在这里冒出来
  const ls = runCommand('npm', ['ls', '--all', '--json'], FRONTEND_DIR)
  const missing = []
  try {
    const tree = JSON.parse(ls.stdout || '{}')
    const walk = (node) => {
      if (!node) {
        return
      }
      for (const [name, info] of Object.entries(node.dependencies ?? {})) {
        if (!info) {
          missing.push(name)
        } else if (info.valid === false || info.required && !info.version) {
          missing.push(name)
        }
        walk(info)
      }
    }
    walk(tree)
  } catch {
    // npm ls 遇到缺失时常以非零退出且输出半截 JSON，交给下面的源码扫描兜底
  }

  // 源码扫描：import 了但依赖清单里没有
  const sourceFiles = listFiles(SRC_DIR, ['.ts', '.vue', '.js'])
  sourceFiles.push(join(FRONTEND_DIR, 'vite.config.ts'))
  const undeclared = new Map() // 包名 -> 首次出现的文件
  for (const file of sourceFiles) {
    const text = readFileSync(file, 'utf8')
    for (const match of text.matchAll(BARE_SPEC_RE)) {
      const name = packageNameOf(match[1])
      if (name && !declared.has(name) && !undeclared.has(name)) {
        undeclared.set(name, relative(REPO_ROOT, file))
      }
    }
  }

  const errors = []
  for (const name of new Set(missing)) {
    errors.push({ file: 'frontend/package.json', message: `缺少已安装依赖：${name}（锁文件与 node_modules 不一致，执行 npm ci 恢复）` })
  }
  for (const [name, file] of undeclared) {
    errors.push({ file, message: `缺少依赖声明：源码引用了 "${name}"，但 package.json 的 dependencies/devDependencies 里没有` })
  }
  return {
    ok: errors.length === 0,
    errors,
    logs: [`已声明依赖 ${declared.size} 个`, `npm ls 缺失 ${missing.length} 处`, `源码未声明引用 ${undeclared.size} 处`],
  }
}

// ---- 阶段 3：类型检查 ----
function parseTscErrors(output) {
  const errors = []
  for (const line of output.split('\n')) {
    const m = line.match(/^(.+?\.(?:ts|vue|tsx))(?:\((\d+),(\d+)\))?:\s*error\s*(TS\d+):\s*(.+)$/)
    if (m) {
      let file = m[1]
      if (file.startsWith(FRONTEND_DIR)) {
        file = relative(REPO_ROOT, file)
      } else if (!file.startsWith('/') && !file.startsWith('frontend/')) {
        file = join('frontend', file)
      }
      errors.push({
        file,
        line: m[2] ? Number(m[2]) : undefined,
        column: m[3] ? Number(m[3]) : undefined,
        code: m[4],
        message: `${m[4]}: ${m[5]}`,
      })
    }
  }
  return errors
}

function stageTypecheck() {
  const res = runCommand('npx', ['vue-tsc', '--noEmit'], FRONTEND_DIR)
  if (res.status === 0) {
    return { ok: true, errors: [], logs: [] }
  }
  const output = `${res.stdout}\n${res.stderr}`
  let errors = parseTscErrors(output)
  if (errors.length === 0) {
    errors = [{ file: 'frontend', message: output.trim().split('\n').slice(-5).join(' / ') || '类型检查未通过，但未解析到具体错误位置' }]
  }
  return { ok: false, errors, logs: output.trim().split('\n').slice(-20) }
}

// ---- 阶段 4：生产构建（先清产物，双跑比对防重复产物）----
function buildOnce() {
  rmSync(DIST_DIR, { recursive: true, force: true })
  const res = runCommand('npx', ['vite', 'build'], FRONTEND_DIR)
  if (res.status !== 0) {
    return { ok: false, manifest: null, logs: `${res.stdout}\n${res.stderr}`.trim().split('\n').slice(-30) }
  }
  const files = listFiles(DIST_DIR, ['']).map((file) => relative(FRONTEND_DIR, file).replaceAll('\\\\', '/'))
  const manifest = {}
  for (const file of files) {
    manifest[file] = sha1(readFileSync(join(FRONTEND_DIR, file)))
  }
  return { ok: true, manifest, logs: res.stdout.trim().split('\n').slice(-15) }
}

function stageBuild() {
  const first = buildOnce()
  if (!first.ok) {
    const tail = first.logs.slice(-3).join(' / ')
    return {
      ok: false,
      errors: [{ file: 'frontend', message: `生产构建失败，定稿被挡下${tail ? `（${tail}）` : ''}` }],
      logs: first.logs,
    }
  }
  // 第二次构建：清掉产物重来，比对清单，确认反复装载不产生重复/漂移产物
  const second = buildOnce()
  if (!second.ok) {
    return { ok: false, errors: [{ file: 'frontend/dist', message: '第二次构建失败' }], logs: second.logs }
  }
  const a = Object.keys(first.manifest).sort()
  const b = Object.keys(second.manifest).sort()
  const onlyA = a.filter((f) => !b.includes(f))
  const onlyB = b.filter((f) => !a.includes(f))
  const drifted = a.filter((f) => b.includes(f) && first.manifest[f] !== second.manifest[f])
  if (onlyA.length || onlyB.length || drifted.length) {
    return {
      ok: false,
      errors: [
        ...onlyA.map((file) => ({ file, message: '重复装载后该产物消失，构建不可复现' })),
        ...onlyB.map((file) => ({ file, message: '重复装载后多出该产物，存在重复产物' })),
        ...drifted.map((file) => ({ file, message: '两次构建内容不一致，构建不确定' })),
      ],
      logs: [],
    }
  }

  // 快照本次产物，作为回滚点
  rmSync(SNAPSHOT_DIR, { recursive: true, force: true })
  mkdirSync(SNAPSHOT_DIR, { recursive: true })
  cpSync(DIST_DIR, SNAPSHOT_DIR, { recursive: true })

  return {
    ok: true,
    errors: [],
    logs: [`产物 ${Object.keys(second.manifest).length} 个，双跑比对一致`, `回滚快照：.release-gate/snapshots/last-release`],
    artifacts: Object.keys(second.manifest).length,
  }
}

const STAGE_RUNNERS = {
  install: stageInstall,
  deps: stageDeps,
  typecheck: stageTypecheck,
  build: stageBuild,
}
const STAGE_TITLES = {
  install: '依赖安装',
  deps: '依赖校验',
  typecheck: '类型检查',
  build: '生产构建',
}

// ---- 报告留档 ----
function renderMarkdown(report) {
  const lines = []
  lines.push(`# 定稿闸门检查报告 ${report.id}`)
  lines.push('')
  lines.push(`- 运行时间：${report.startedAt}`)
  lines.push(`- 结论：${report.passed ? '✅ 通过，允许定稿' : '❌ 未通过，定稿被挡下'}`)
  lines.push(`- Node：${report.node}`)
  lines.push('')
  lines.push('| 阶段 | 结果 | 耗时 | 说明 |')
  lines.push('| --- | --- | --- | --- |')
  for (const stage of report.stages) {
    const result = stage.ok ? '通过' : stage.skipped ? '跳过（输入未变）' : '失败'
    lines.push(`| ${STAGE_TITLES[stage.stage]}（${stage.stage}） | ${result} | ${stage.durationMs} ms | ${stage.note} |`)
  }
  const failures = report.stages.filter((stage) => !stage.ok && !stage.skipped)
  if (failures.length) {
    lines.push('')
    lines.push('## 挡下定稿的问题')
    for (const stage of failures) {
      lines.push('')
      lines.push(`### ${STAGE_TITLES[stage.stage]}`)
      const fileErrors = stage.errors.filter((e) => e.file)
      const missing = stage.errors.filter((e) => e.message.includes('缺少'))
      if (missing.length) {
        lines.push('')
        lines.push('缺少的依赖：')
        for (const e of missing) {
          lines.push(`- ${e.message}（发现于 ${e.file}）`)
        }
      }
      const others = stage.errors.filter((e) => !missing.includes(e))
      if (others.length) {
        lines.push('')
        lines.push('出错的文件：')
        for (const e of others) {
          const pos = e.line ? `:${e.line}${e.column ? `:${e.column}` : ''}` : ''
          lines.push(`- \`${e.file}${pos}\` — ${e.message}`)
        }
      }
      if (stage.logs && stage.logs.length) {
        lines.push('')
        lines.push('<details><summary>阶段输出（末尾）</summary>')
        lines.push('')
        lines.push('```text')
        lines.push(...stage.logs.slice(-20))
        lines.push('```')
        lines.push('</details>')
      }
    }
  }
  lines.push('')
  return lines.join('\n')
}

// ---- 主流程 ----
function parseArgs(argv) {
  return {
    stage: (argv.find((a) => a.startsWith('--stage='))?.split('=')[1]) ??
      (argv.includes('--stage') ? argv[argv.indexOf('--stage') + 1] : 'build'),
    force: argv.includes('--force'),
    reset: argv.includes('--reset'),
  }
}

function main() {
  const args = parseArgs(process.argv.slice(2))
  mkdirSync(STATE_DIR, { recursive: true })

  if (args.reset) {
    rmSync(join(REPO_ROOT, '.release-gate', 'state'), { recursive: true, force: true })
    log(warn('已清空闸门续跑状态（.release-gate/state），下次从头检查'))
    return 0
  }

  const targetIndex = STAGES.indexOf(args.stage)
  if (targetIndex < 0) {
    log(bad(`未知阶段 "${args.stage}"，可选：${STAGES.join(' / ')}`))
    return 2
  }
  const todo = STAGES.slice(0, targetIndex + 1)

  const startedAt = new Date()
  const runId = startedAt.toISOString().replace(/[:.]/g, '-')
  log(info('━━━ 发掘简报定稿闸门 ━━━'))
  log(dim(`运行批次 ${runId}，目标阶段：${STAGE_TITLES[args.stage]}`))

  const markers = args.force ? {} : loadMarkers()
  const stageReports = []
  let passed = true
  // 链式有效：前一阶段重跑或失效，后一阶段的旧标记也跟着失效，
  // 保证重装依赖后依赖校验/类型检查/构建全部重跑。
  let chainFp = 'start'

  for (const stage of todo) {
    const fp = fingerprint(stage)
    const effectiveFp = sha1(`${chainFp}|${fp}`)
    const stamp = markers[stage]
    const started = Date.now()
    if (stamp && stamp.fingerprint === effectiveFp) {
      log(ok(`✔ ${STAGE_TITLES[stage]}：跳过（输入未变，${new Date(stamp.at).toLocaleString()} 已通过）`))
      stageReports.push({ stage, ok: true, skipped: true, durationMs: 0, errors: [], logs: [], note: '输入未变，沿用上轮结果', fingerprint: effectiveFp })
      chainFp = effectiveFp
      continue
    }
    log(info(`▶ ${STAGE_TITLES[stage]}：开始检查…`))
    let result
    try {
      result = STAGE_RUNNERS[stage]()
    } catch (error) {
      result = { ok: false, errors: [{ file: 'scripts/release-gate.mjs', message: `阶段执行异常：${error instanceof Error ? error.message : String(error)}` }], logs: [] }
    }
    const durationMs = Date.now() - started
    if (result.ok) {
      markers[stage] = { fingerprint: effectiveFp, at: new Date().toISOString() }
      saveMarkers(markers) // 每过一段立即落盘，中断后从下一段续跑
      chainFp = effectiveFp
      log(ok(`✔ ${STAGE_TITLES[stage]}：通过（${durationMs} ms）`))
      for (const line of result.logs ?? []) {
        log(dim(`  ${line}`))
      }
      stageReports.push({ stage, ok: true, skipped: false, durationMs, errors: [], logs: result.logs ?? [], note: '通过', fingerprint: effectiveFp, artifacts: result.artifacts })
    } else {
      log(bad(`✘ ${STAGE_TITLES[stage]}：失败（${durationMs} ms），定稿被挡下`))
      for (const e of result.errors ?? []) {
        log(bad(`  - [${e.file}] ${e.message}`))
      }
      stageReports.push({ stage, ok: false, skipped: false, durationMs, errors: result.errors ?? [], logs: result.logs ?? [], note: `失败 ${result.errors?.length ?? 0} 项`, fingerprint: effectiveFp })
      passed = false
      break // 挡下后面的阶段
    }
  }

  const report = {
    id: runId,
    startedAt: startedAt.toISOString(),
    node: process.version,
    cwd: REPO_ROOT,
    targetStage: args.stage,
    passed,
    stages: stageReports,
  }

  // 留档：全量历史 JSON 放 .release-gate/runs（本地/CI 工件，不入库）；
  // release-records 只保留最新一份报告随仓库走
  writeJsonAtomic(join(RUNS_DIR, `${runId}.json`), report)
  writeJsonAtomic(join(RUNS_DIR, 'latest.json'), report)
  mkdirSync(RECORDS_DIR, { recursive: true })
  writeFileSync(join(RECORDS_DIR, 'latest.md'), renderMarkdown(report))
  writeJsonAtomic(join(RECORDS_DIR, 'latest.json'), report)

  log('')
  if (passed) {
    log(ok('━━━ 闸门通过：可以定稿/发布 ━━━'))
    log(dim(`留档：${relative(REPO_ROOT, join(RECORDS_DIR, 'latest.md'))}`))
    return 0
  }
  log(bad('━━━ 闸门未通过：已挡下定稿，请按上面的文件/依赖清单修复后重跑 ━━━'))
  log(dim(`只补跑未完成阶段：node scripts/release-gate.mjs（已通过阶段自动跳过）`))
  log(dim(`留档：${relative(REPO_ROOT, join(RECORDS_DIR, 'latest.md'))}`))
  return 1
}

process.exit(main())
