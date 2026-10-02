<template>
  <section class="page" data-module="briefing">
    <header class="page-head">
      <div>
        <h2>简报校核管理</h2>
        <p class="page-desc">维护发掘简报，围绕简报编号、涉及探方、编写人、初稿日期做登记、筛选与状态流转。</p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openCreate">登记发掘简报</button>
        <button class="btn" type="button" @click="exportRows">导出简报校核清单</button>
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

    <section class="pipeline-banner" :class="pipelinePassed ? 'passed' : 'blocked'">
      <template v-if="pipelineStatus">
        <p class="pipeline-line">
          定稿前检查：{{ pipelineStatus.result === 'passed' ? '已通过' : '未通过，定稿已挡下' }}
          （{{ pipelineStatus.finishedAt }}<template v-if="pipelineStatus.failedStage">，失败阶段：{{ pipelineStatus.failedStage }}</template>）
        </p>
        <template v-if="pipelineStatus.result !== 'passed'">
          <ul v-if="pipelineStatus.errorFiles.length" class="pipeline-list">
            <li v-for="file in pipelineStatus.errorFiles" :key="file">出错文件：{{ file }}</li>
          </ul>
          <ul v-if="pipelineStatus.missingDeps.length" class="pipeline-list">
            <li v-for="dep in pipelineStatus.missingDeps" :key="dep">缺失依赖：{{ dep }}</li>
          </ul>
        </template>
        <p class="pipeline-line muted">回滚策略：{{ pipelineStatus.rollbackHint }}</p>
      </template>
      <p v-else class="pipeline-line">
        定稿前检查尚未运行：先执行 <code>make pipeline</code>（依赖校验 → 类型检查 → 构建），通过后「确认定稿」才会放行。
      </p>
    </section>

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

    <footer class="page-foot">
      <span>共 {{ total }} 条简报校核记录</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>

    <section v-if="archive.length" class="archive-section">
      <h3 class="archive-title">定稿留档</h3>
      <table class="data-table">
        <thead>
          <tr>
            <th>留档时间</th>
            <th>简报编号</th>
            <th>涉及探方</th>
            <th>校核结论</th>
            <th>验收待办</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="item in archive" :key="`${item.briefingId}-${item.archivedAt}`">
            <td>{{ item.archivedAt }}</td>
            <td>{{ item.briefingNo }}</td>
            <td>{{ item.trenches }}</td>
            <td>{{ item.conclusion }}</td>
            <td>{{ item.acceptanceNo }}</td>
          </tr>
        </tbody>
      </table>
    </section>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import {
  downloadEntries,
  listEntries,
  listFinalizationArchive,
  moduleMeta,
  runAction as applyAction,
  type FinalizationArchiveEntry,
} from '@/api/local-service'
import { loadPipelineStatus, type PipelineStatus } from '@/api/pipeline-status'
import type { EntryRow } from '@/data/types'

const meta = moduleMeta('briefing')
const columns = ["简报编号", "涉及探方", "编写人", "初稿日期", "校核意见数", "校核结论", "定稿日期", "简报状态"]
const actions = ["提交校核", "确认定稿", "退回修改"]
const statuses = ["待编写", "待校核", "已定稿", "已退回"]
const stats = [{"label": "待编写简报", "value": 0}, {"label": "待校核简报", "value": 0}, {"label": "本月定稿数", "value": 0}]

const rows = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const filters = ref<Record<string, string>>({})
const pipelineStatus = ref<PipelineStatus | null>(null)
const archive = ref<FinalizationArchiveEntry[]>([])
const filterFields = columns.slice(0, 3)
const statusSummary = computed(() =>
  statuses.map((status: string) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)
const pipelinePassed = computed(() => pipelineStatus.value?.result === 'passed')

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
}

function openCreate() {
  errorMessage.value = '发掘简报登记入口尚未接入审批流'
}

/** 定稿闸口：检查没跑或未通过就挡下，把出错文件、缺失依赖和回滚策略摆出来。 */
function finalizeBlockReason(): string {
  const status = pipelineStatus.value
  if (!status) {
    return '定稿前检查尚未运行，请先执行 make pipeline，通过后再定稿'
  }
  if (status.result !== 'passed') {
    const parts = [`定稿前检查未通过（失败阶段：${status.failedStage ?? '未知'}），定稿已挡下`]
    if (status.errorFiles.length) {
      parts.push(`出错文件：${status.errorFiles.join('、')}`)
    }
    if (status.missingDeps.length) {
      parts.push(`缺失依赖：${status.missingDeps.join('、')}`)
    }
    parts.push(`回滚策略：${status.rollbackHint}`)
    return parts.join('；')
  }
  return ''
}

function runAction(action: string, row: EntryRow) {
  errorMessage.value = ''
  if (action === '确认定稿') {
    const blocked = finalizeBlockReason()
    if (blocked) {
      errorMessage.value = blocked
      return
    }
  }
  const result = applyAction(meta.key, Number(row.id), action)
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  if (action === '确认定稿') {
    archive.value = listFinalizationArchive()
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

onMounted(async () => {
  reload()
  archive.value = listFinalizationArchive()
  pipelineStatus.value = await loadPipelineStatus()
})
</script>
