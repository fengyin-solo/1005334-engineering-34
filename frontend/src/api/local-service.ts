import { MODULE_BY_KEY } from '@/data/modules'
import { allRows, listRows, resetRows, saveRows } from '@/data/local-store'
import type { ActionResult, EntryRow, ModuleMeta, OverviewResult, PageResult } from '@/data/types'

// 会写进数据的「往回走」动作：命中就把这条记录标成异常态，看板上能一眼看出来。
const NEGATIVE_ACTIONS = ['撤销', '作废', '拒绝', '驳回', '停用', '忽略', '下线', '回滚']

// 定稿留档：每次简报定稿追加一条，键名与业务数据分开，重置模块不会清掉留档。
const FINALIZATION_ARCHIVE_KEY = 'archaeology-field:finalization-archive'

export type FinalizationArchiveEntry = {
  archivedAt: string
  briefingId: number
  briefingNo: string
  trenches: string
  conclusion: string
  acceptanceId: number
  acceptanceNo: string
}

export function moduleMeta(key: string): ModuleMeta {
  const meta = MODULE_BY_KEY.get(key)
  if (!meta) {
    throw new Error(`没有登记名为 ${key} 的业务模块`)
  }
  return meta
}

export function filterRows(rows: EntryRow[], filters: Record<string, string>): EntryRow[] {
  const pairs = Object.entries(filters).filter(([, value]) => value.trim() !== '')
  if (pairs.length === 0) {
    return rows
  }
  return rows.filter((row) =>
    pairs.every(([field, value]) => String(row[field] ?? '').includes(value.trim())),
  )
}

export function listEntries(key: string, filters: Record<string, string> = {}): PageResult {
  const matched = filterRows(listRows(key), filters)
  return { items: matched, total: matched.length, page: 1, size: matched.length }
}

export function runAction(key: string, id: number, action: string): ActionResult {
  const meta = moduleMeta(key)
  const target = meta.actionTargets[action]
  if (!target) {
    return { ok: false, message: `${meta.entity}没有登记「${action}」这个动作` }
  }
  const rows = listRows(key)
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的${meta.entity}` }
  }
  const current = String(rows[index].status)
  if (current === target) {
    return { ok: false, message: `${meta.entity}已经是「${target}」，不用重复操作` }
  }
  const lastStatus = meta.statuses[meta.statuses.length - 1]
  const updated: EntryRow = {
    ...rows[index],
    status: target,
    pending: target !== lastStatus,
    abnormal: NEGATIVE_ACTIONS.some((verb) => action.startsWith(verb)),
  }
  const next = [...rows]
  next[index] = updated
  saveRows(key, next)
  let extra = ''
  if (key === 'briefing' && action === '确认定稿') {
    extra = finalizeBriefing(updated)
  }
  return { ok: true, message: `${meta.entity}已${action}，当前状态「${target}」${extra}` }
}

/**
 * 简报定稿的后续动作：把定稿结果落成一条「待验收」的探方验收单（验收待办），
 * 并把这次定稿的关键信息追加到留档里。
 */
function finalizeBriefing(briefing: EntryRow): string {
  const acceptanceRows = listRows('acceptance')
  const nextId = acceptanceRows.reduce((max, row) => Math.max(max, Number(row.id) || 0), 0) + 1
  const acceptanceNo = `ACCE-${String(nextId).padStart(4, '0')}`
  const today = new Date().toISOString().slice(0, 10)
  const entry: EntryRow = {
    id: nextId,
    status: '待验收',
    pending: true,
    abnormal: false,
    验收单号: acceptanceNo,
    验收探方: String(briefing['涉及探方'] ?? ''),
    验收类别: '简报定稿复核',
    验收人: '待指派',
    验收日期: today,
    遗留问题数: 0,
    验收结论: `简报${String(briefing['简报编号'] ?? '')}已定稿，待验收`,
    验收状态: '待验收',
  }
  saveRows('acceptance', [...acceptanceRows, entry])
  archiveFinalization(briefing, entry)
  return `；定稿结果已转入探方验收待办（${acceptanceNo}），本次检查结果已留档`
}

function readFinalizationArchive(): FinalizationArchiveEntry[] {
  if (typeof window === 'undefined' || !window.localStorage) {
    return []
  }
  try {
    return JSON.parse(window.localStorage.getItem(FINALIZATION_ARCHIVE_KEY) ?? '[]') as FinalizationArchiveEntry[]
  } catch {
    return []
  }
}

export function listFinalizationArchive(): FinalizationArchiveEntry[] {
  return readFinalizationArchive()
}

function archiveFinalization(briefing: EntryRow, acceptance: EntryRow): void {
  const entry: FinalizationArchiveEntry = {
    archivedAt: new Date().toISOString(),
    briefingId: Number(briefing.id),
    briefingNo: String(briefing['简报编号'] ?? ''),
    trenches: String(briefing['涉及探方'] ?? ''),
    conclusion: String(briefing['校核结论'] ?? ''),
    acceptanceId: Number(acceptance.id),
    acceptanceNo: String(acceptance['验收单号'] ?? ''),
  }
  if (typeof window !== 'undefined' && window.localStorage) {
    const next = [...readFinalizationArchive(), entry]
    window.localStorage.setItem(FINALIZATION_ARCHIVE_KEY, JSON.stringify(next))
  }
}

export function resetModule(key: string): PageResult {
  resetRows(key)
  return listEntries(key)
}

export function exportEntries(key: string): { filename: string; content: string } {
  const meta = moduleMeta(key)
  const header = ['编号', ...meta.fields, '当前状态']
  const lines = [header.join(',')]
  for (const row of listRows(key)) {
    lines.push([row.id, ...meta.fields.map((field) => row[field] ?? ''), row.status].join(','))
  }
  return { filename: `${meta.name}-清单.csv`, content: `\uFEFF${lines.join('\n')}` }
}

export function downloadEntries(key: string): void {
  const { filename, content } = exportEntries(key)
  const blob = new Blob([content], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  URL.revokeObjectURL(url)
}

export function loadOverview(): OverviewResult {
  const rows = allRows()
  const modules = [...MODULE_BY_KEY.values()].map((meta) => {
    const entries = rows[meta.key] ?? []
    return {
      name: meta.name,
      created: entries.length,
      pending: entries.filter((row) => row.pending).length,
      abnormal: entries.filter((row) => row.abnormal).length,
    }
  })
  const cards = [
    { label: '业务模块', value: modules.length },
    { label: '登记总量', value: modules.reduce((sum, item) => sum + item.created, 0) },
    { label: '待处理', value: modules.reduce((sum, item) => sum + item.pending, 0) },
    { label: '异常量', value: modules.reduce((sum, item) => sum + item.abnormal, 0) },
  ]
  return { cards, modules }
}
