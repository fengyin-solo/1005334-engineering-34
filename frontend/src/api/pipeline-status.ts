// 定稿前检查的结果由 scripts/finalization-pipeline.mjs 写到 public/pipeline-status.json，
// 页面在定稿前读这份文件：通过才放行「确认定稿」，未通过就把出错文件和缺失依赖亮出来。

export type PipelineStatus = {
  result: 'passed' | 'failed'
  finishedAt: string
  failedStage: string | null
  errorFiles: string[]
  missingDeps: string[]
  rollbackHint: string
  report?: string
}

export async function loadPipelineStatus(): Promise<PipelineStatus | null> {
  try {
    const response = await fetch(`${import.meta.env.BASE_URL}pipeline-status.json`, {
      cache: 'no-store',
    })
    if (!response.ok) {
      return null
    }
    return (await response.json()) as PipelineStatus
  } catch {
    return null
  }
}
