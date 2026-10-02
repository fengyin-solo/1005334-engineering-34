/**
 * 定稿闸门（应用侧）：发掘简报「确认定稿」前必须跑的检查。
 *
 * 仓库里的 scripts/release-gate.mjs 负责发布级的依赖校验、类型检查与生产构建；
 * 这里负责业务域内的定稿检查——简报本身的编号、涉及探方、校核结论是否站得住，
 * 以及页面运行所需的本地数据依赖是否齐全。
 *
 * 通过后两件事：
 * 1. 在「探方验收」模块生成一条验收待办（已定稿简报涉及的探方进入验收队列）；
 * 2. 本次检查结果写进闸门留档（localStorage），可在简报页导出。
 */

import { MODULE_BY_KEY } from './modules'
import { listRows, saveRows } from './local-store'
import type { EntryRow } from './types'

const REPORT_STORAGE_KEY = 'archaeology-field:gate-reports'
const REPORT_KEEP = 50

export type GateCheck = {
  name: string
  passed: boolean
  message: string
}

export type GateReport = {
  id: string
  target: 'briefing'
  briefingId: number
  briefingNo: string
  trenches: string[]
  checkedAt: string
  passed: boolean
  checks: GateCheck[]
  errorFiles: { file: string; message: string }[]
  missingDeps: string[]
  acceptanceTodoNo: string | null
}

const FINAL_STATUS = '已定稿'
const ACCEPTANCE_FIRST_STATUS = '待验收'

function today(): string {
  return new Date().toISOString().slice(0, 10)
}

function readReports(): GateReport[] {
  if (typeof window === 'undefined' || !window.localStorage) {
    return []
  }
  try {
    const raw = window.localStorage.getItem(REPORT_STORAGE_KEY)
    return raw ? (JSON.parse(raw) as GateReport[]) : []
  } catch {
    return []
  }
}

function writeReports(reports: GateReport[]): void {
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.setItem(REPORT_STORAGE_KEY, JSON.stringify(reports.slice(0, REPORT_KEEP)))
  }
}

// 闸门留档也要随模块重置一起清
export function resetGateReports(): GateReport[] {
  writeReports([])
  return []
}

export function listGateReports(): GateReport[] {
  return readReports()
}

/** 「涉及探方」可能是多个探方编号的组合，统一拆开校验 */
function parseTrenches(value: unknown): string[] {
  return String(value ?? '')
    .split(/[、,，;；\s]+/)
    .map((item) => item.trim())
    .filter(Boolean)
}

function knownTrenchNos(): Set<string> {
  return new Set(
    listRows('trench')
      .map((row) => String(row['探方编号'] ?? '').trim())
      .filter(Boolean),
  )
}

function buildAcceptanceTodo(report: GateReport): EntryRow {
  const rows = listRows('acceptance')
  const nextId = rows.reduce((max, row) => Math.max(max, Number(row.id) || 0), 0) + 1
  const seq = rows.reduce((max, row) => {
    const m = String(row['验收单号'] ?? '').match(/(\d+)$/)
    return m ? Math.max(max, Number(m[1])) : max
  }, 1000) + 1
  const no = `ACCE-GATE-${String(seq).slice(-4)}`
  report.acceptanceTodoNo = no
  return {
    id: nextId,
    status: ACCEPTANCE_FIRST_STATUS,
    pending: true,
    abnormal: false,
    验收单号: no,
    验收探方: report.trenches.join('、'),
    验收类别: '简报定稿验收',
    验收人: '',
    验收日期: '',
    遗留问题数: 0,
    验收结论: '',
    验收状态: '待验收',
    来源简报: report.briefingNo,
  }
}

/**
 * 跑定稿闸门。checkOnly=true 时只检查、不写任何数据，供页面预检。
 * 已通过闸门并定稿的简报重复触发，直接幂等返回成功（验收待办不会重复生成）。
 */
export function runFinalizeGate(briefingId: number, checkOnly = false): GateReport {
  const briefingRows = listRows('briefing')
  const briefing = briefingRows.find((row) => Number(row.id) === briefingId)
  const id = `GATE-${new Date().toISOString().replace(/[:.]/g, '-')}`

  const report: GateReport = {
    id,
    target: 'briefing',
    briefingId,
    briefingNo: briefing ? String(briefing['简报编号'] ?? `#${briefingId}`) : `#${briefingId}`,
    trenches: briefing ? parseTrenches(briefing['涉及探方']) : [],
    checkedAt: new Date().toISOString(),
    passed: false,
    checks: [],
    errorFiles: [],
    missingDeps: [],
    acceptanceTodoNo: null,
  }

  if (!briefing) {
    report.checks.push({ name: '简报存在性', passed: false, message: `找不到编号 ${briefingId} 的发掘简报` })
    report.errorFiles.push({ file: 'briefing 模块数据', message: `简报 ${briefingId} 不存在` })
    archive(report)
    return report
  }

  // 幂等：已经是「已定稿」且之前已生成过验收待办，就不再重复落结果
  const alreadyFinalized = String(briefing.status) === FINAL_STATUS
  if (alreadyFinalized) {
    const todoExists = listRows('acceptance').some(
      (row) => String(row['来源简报'] ?? '') === report.briefingNo,
    )
    if (todoExists) {
      report.passed = true
      report.checks.push({ name: '定稿状态', passed: true, message: '已定稿，验收待办已存在，跳过重复处理' })
      report.acceptanceTodoNo =
        listRows('acceptance').find((row) => String(row['来源简报'] ?? '') === report.briefingNo)?.['验收单号'] as
          | string
          | undefined ?? null
      archive(report)
      return report
    }
  }

  // 检查 1：简报编号
  const no = String(briefing['简报编号'] ?? '').trim()
  report.checks.push({
    name: '简报编号',
    passed: no.length > 0,
    message: no ? `简报编号 ${no} 已填写` : '简报编号为空，不允许定稿',
  })

  // 检查 2：涉及探方，且每个探方在探方登记里查得到
  const trenches = parseTrenches(briefing['涉及探方'])
  const known = knownTrenchNos()
  const unknownTrenches = trenches.filter((t) => !known.has(t))
  report.checks.push({
    name: '涉及探方',
    passed: trenches.length > 0 && unknownTrenches.length === 0,
    message:
      trenches.length === 0
        ? '涉及探方为空，不允许定稿'
        : unknownTrenches.length
          ? `涉及探方在探方登记中查无此号：${unknownTrenches.join('、')}`
          : `涉及探方 ${trenches.join('、')} 均已登记`,
  })

  // 检查 3：校核结论
  const conclusion = String(briefing['校核结论'] ?? '').trim()
  const conclusionBad = conclusion.length === 0 || conclusion.includes('样例')
  report.checks.push({
    name: '校核结论',
    passed: !conclusionBad,
    message: conclusionBad ? '校核结论缺失或仍是占位样例内容，不允许定稿' : `校核结论：${conclusion}`,
  })

  // 检查 4：校核意见数必须是非负整数
  const opinionRaw = briefing['校核意见数']
  const opinionNum = Number(opinionRaw)
  const opinionOk = opinionRaw !== '' && opinionRaw !== undefined && Number.isInteger(opinionNum) && opinionNum >= 0
  report.checks.push({
    name: '校核意见数',
    passed: opinionOk,
    message: opinionOk ? `校核意见 ${opinionNum} 条` : `校核意见数不是非负整数：${String(opinionRaw)}`,
  })

  // 检查 5：本地数据依赖（模块元数据齐备，等同于闸门里的「依赖校验」）
  const metaOk = ['briefing', 'acceptance', 'trench'].every((key) => MODULE_BY_KEY.has(key))
  report.checks.push({
    name: '数据依赖校验',
    passed: metaOk,
    message: metaOk ? '简报/验收/探方模块元数据齐全' : '缺少模块元数据依赖（briefing/acceptance/trench）',
  })
  if (!metaOk) {
    report.missingDeps.push('data/modules.ts 中的模块元数据')
  }

  // 检查 6：只有「待校核」状态（即已经提交校核）才允许确认定稿；
  // 已退回的要先走「提交校核」回来，避免绕过校核直接定稿。
  const statusOk = String(briefing.status) === '待校核'
  report.checks.push({
    name: '流转前置状态',
    passed: statusOk,
    message: statusOk
      ? '当前「待校核」，允许确认定稿'
      : `当前状态「${briefing.status}」不允许定稿，请先提交校核`,
  })

  report.passed = report.checks.every((check) => check.passed)

  // 把失败项归并成「出错文件」清单，和发布闸门报告口径保持一致
  for (const check of report.checks.filter((c) => !c.passed)) {
    report.errorFiles.push({ file: `briefing#${briefing.id}（${check.name}）`, message: check.message })
  }

  if (!report.passed) {
    archive(report)
    return report
  }

  if (checkOnly) {
    report.checks.push({ name: '预检', passed: true, message: '预检通过，尚未写状态、未落验收待办' })
    return report
  }

  // 定稿：只改这一条简报的状态与定稿日期
  const nextBriefingRows = [...briefingRows]
  const index = nextBriefingRows.findIndex((row) => Number(row.id) === briefingId)
  const draftDate = briefing['定稿日期']
  nextBriefingRows[index] = {
    ...briefing,
    status: FINAL_STATUS,
    pending: false,
    定稿日期: String(draftDate ?? '').trim() ? draftDate : today(),
  }
  saveRows('briefing', nextBriefingRows)

  // 落到验收待办：同一简报只生成一条
  if (!listRows('acceptance').some((row) => String(row['来源简报'] ?? '') === report.briefingNo)) {
    const acceptanceRows = listRows('acceptance')
    saveRows('acceptance', [...acceptanceRows, buildAcceptanceTodo(report)])
  } else {
    const existed = listRows('acceptance').find((row) => String(row['来源简报'] ?? '') === report.briefingNo)
    report.acceptanceTodoNo = existed ? String(existed['验收单号']) : null
  }

  archive(report)
  return report
}

function archive(report: GateReport): void {
  const reports = readReports()
  reports.unshift(report)
  writeReports(reports)
}
