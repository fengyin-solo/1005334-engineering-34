// 应用侧定稿闸门冒烟测试：用 node_modules 里的 esbuild（vite 自带）即时转译 TS，
// 在内存 localStorage 上跑三类场景，不依赖浏览器、不联网。
import { writeFileSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const scriptsDir = dirname(fileURLToPath(import.meta.url))
const root = resolve(scriptsDir, '..')
const frontend = join(root, 'frontend')
const esbuildPath = pathToFileURL(join(frontend, 'node_modules', 'esbuild', 'lib', 'main.js')).href
const { build } = await import(esbuildPath)

const probe = `
import { runFinalizeGate, listGateReports } from './src/data/release-gate'
import { listRows, saveRows } from './src/data/local-store'

const ls: Record<string, string> = {}
;(globalThis as any).window = { localStorage: {
  getItem: (k: string) => (k in ls ? ls[k] : null),
  setItem: (k: string, v: string) => { ls[k] = String(v) },
} }

function dump(label: string, r: any) {
  console.log(label, 'passed=', r.passed, 'todo=', r.acceptanceTodoNo)
  for (const c of r.checks) console.log('  ', c.passed ? 'OK  ' : 'FAIL', c.name, '::', c.message)
}

// 场景 1：直接定稿样例简报（涉及探方/校核结论都是占位样例，应被挡下）
dump('CASE1', runFinalizeGate(2, false))

// 场景 2：改成合法数据（涉及探方用已登记的 TREN-0001）
{
  const rows = listRows('briefing')
  const b = rows.find((x: any) => x.id === 2)
  b['涉及探方'] = 'TREN-0001'
  b['校核结论'] = '校核通过，同意定稿'
  b['校核意见数'] = 0
  saveRows('briefing', rows)
}
dump('CASE2', runFinalizeGate(2, false))

const todosAfter2 = listRows('acceptance').filter((x: any) => x['来源简报'] === 'BRIE-0002')
console.log('CASE2 acceptance todos =', todosAfter2.length, JSON.stringify(todosAfter2[0] && {
  no: todosAfter2[0]['验收单号'], trenches: todosAfter2[0]['验收探方'],
  kind: todosAfter2[0]['验收类别'], status: todosAfter2[0].status,
}))

// 场景 3：重复定稿幂等，不产生第二条待办
const r3 = runFinalizeGate(2, false)
const todosAfter3 = listRows('acceptance').filter((x: any) => x['来源简报'] === 'BRIE-0002')
const finalized = listRows('briefing').find((x: any) => x.id === 2)
console.log('CASE3 repeat passed=', r3.passed, 'todos=', todosAfter3.length,
  'briefing.status=', finalized.status, '定稿日期=', finalized['定稿日期'])

// 场景 4：不存在的简报
dump('CASE4', runFinalizeGate(9999, false))

console.log('REPORTS archived =', listGateReports().length)

// 断言
const failures: string[] = []
if (todosAfter2.length !== 1) failures.push('CASE2 应恰好生成 1 条验收待办')
if (todosAfter3.length !== 1) failures.push('CASE3 重复定稿不得再生成待办')
if (finalized.status !== '已定稿') failures.push('CASE3 简报应为已定稿')
if (failures.length) { console.error('ASSERT_FAIL', failures); process.exit(1) }
console.log('ASSERT_OK')
`

const entry = join(frontend, '__gate_probe.ts')
const outfile = join(frontend, '__gate_probe.mjs')
writeFileSync(entry, probe)
try {
  await build({
    entryPoints: [entry],
    outfile,
    bundle: true,
    platform: 'node',
    format: 'esm',
    logLevel: 'silent',
    alias: { '@': join(frontend, 'src') },
  })
  await import(pathToFileURL(outfile).href + `?t=${Date.now()}`)
} finally {
  rmSync(entry, { force: true })
  rmSync(outfile, { force: true })
}
