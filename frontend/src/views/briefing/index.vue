<template>
  <section class="page" data-module="briefing">
    <header class="page-head">
      <div>
        <h2>简报校核管理</h2>
        <p class="page-desc">维护发掘简报，围绕简报编号、涉及探方、编写人、初稿日期做登记、筛选与状态流转。确认定稿前必须通过定稿闸门（编号、涉及探方、校核结论、依赖校验）。</p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openCreate">登记发掘简报</button>
        <button class="btn" type="button" @click="exportRows">导出简报校核清单</button>
        <button class="btn" type="button" @click="exportGateReports">导出闸门检查留档</button>
      </div>
    </header>

    <div class="stat-row">
      <article v-for="item in stats" :key="item.label" class="stat-card">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value">{{ item.value }}</strong>
      </article>
    </div>

    <p class="status-legend">
      <span v-for="item in statusSummary" :key="item.status" class="legend-item">
        {{ item.status }}：{{ item.count }}
      </span>
    </p>

    <form class="filter-bar" @submit.prevent="reload">
      <label v-for="field in filterFields" :key="field" class="filter-item">
        <span>{{ field }}</span>
        <input v-model="filters[field]" :placeholder="`按${field}检索`" />
      </label>
      <button class="btn" type="submit">查询</button>
      <button class="btn ghost" type="button" @click="resetFilters">重置条件</button>
    </form>

    <table class="data-table">
      <thead>
        <tr>
          <th v-for="column in columns" :key="column">{{ column }}</th>
          <th>当前状态</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="String(row.id)">
          <td v-for="column in columns" :key="column">{{ row[column] ?? '—' }}</td>
          <td>{{ row.status }}</td>
          <td class="row-actions">
            <button
              v-for="action in actions"
              :key="action"
              class="link"
              type="button"
              @click="runAction(action, row)"
            >
              {{ action }}
            </button>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 2" class="empty-state">暂无简报校核数据，可先登记发掘简报</td>
        </tr>
      </tbody>
    </table>

    <section v-if="gateReport" class="gate-panel" :class="gateReport.passed ? 'gate-pass' : 'gate-fail'">
      <h3>定稿闸门检查结果（{{ gateReport.id }}）</h3>
      <ul>
        <li v-for="check in gateReport.checks" :key="check.name">
          <span :class="check.passed ? 'gate-ok' : 'gate-no'">{{ check.passed ? '✔' : '✘' }}</span>
          <strong>{{ check.name }}</strong>：{{ check.message }}
        </li>
      </ul>
      <p v-if="!gateReport.passed">
        定稿已被挡下：出错项 {{ gateReport.errorFiles.length }} 条，缺少依赖 {{ gateReport.missingDeps.length }} 项，修复后重新点「确认定稿」。
      </p>
      <p v-else>
        检查通过，简报已定稿；验收待办单号 <strong>{{ gateReport.acceptanceTodoNo ?? '—' }}</strong>，已落到「探方验收」模块。
      </p>
    </section>

    <footer class="page-foot">
      <span>共 {{ total }} 条简报校核记录</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import {
  downloadEntries,
  listEntries,
  moduleMeta,
  runAction as applyAction,
} from '@/api/local-service'
import {
  listGateReports,
  runFinalizeGate,
  type GateReport,
} from '@/data/release-gate'
import type { EntryRow } from '@/data/types'

const meta = moduleMeta('briefing')
const columns = ["简报编号", "涉及探方", "编写人", "初稿日期", "校核意见数", "校核结论", "定稿日期", "简报状态"]
const actions = ["提交校核", "确认定稿", "退回修改"]
const statuses = ["待编写", "待校核", "已定稿", "已退回"]
const stats = [{"label": "待编写简报", "value": 0}, {"label": "待校核简报", "value": 0}, {"label": "本月定稿数", "value": 0}]

const rows = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const gateReport = ref<GateReport | null>(null)
const filters = ref<Record<string, string>>({})
const filterFields = columns.slice(0, 3)
const statusSummary = computed(() =>
  statuses.map((status: string) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
}

function exportGateReports() {
  const reports = listGateReports()
  if (!reports.length) {
    errorMessage.value = '还没有定稿闸门检查记录'
    return
  }
  errorMessage.value = ''
  const blob = new Blob([JSON.stringify(reports, null, 2)], {
    type: 'application/json;charset=utf-8',
  })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = '定稿闸门检查留档.json'
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  URL.revokeObjectURL(url)
}

function openCreate() {
  errorMessage.value = '发掘简报登记入口尚未接入审批流'
}

function runAction(action: string, row: EntryRow) {
  errorMessage.value = ''
  // 「确认定稿」必须先过定稿闸门；其他动作仍走统一状态流转
  if (action === '确认定稿') {
    const report = runFinalizeGate(Number(row.id), false)
    gateReport.value = report
    reload()
    if (!report.passed) {
      const failed = report.checks
        .filter((check) => !check.passed)
        .map((check) => check.message)
        .join('；')
      errorMessage.value = `定稿闸门未通过，已挡下定稿：${failed}`
    }
    return
  }
  gateReport.value = null
  const result = applyAction(meta.key, Number(row.id), action)
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  reload()
}

function reload() {
  errorMessage.value = ''
  try {
    const payload = listEntries(meta.key, filters.value)
    rows.value = payload.items
    total.value = payload.total
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '简报校核列表读取失败'
  }
}

onMounted(reload)
</script>
