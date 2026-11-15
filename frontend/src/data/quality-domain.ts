import type { EntryRow } from './types'

/**
 * 质量监控领域存储：监控对象（质量指标）→ 检测批次记录 → 检索索引状态 这条调用链的持久化。
 * 主数据（指标、索引）仍走 local-store 的统一存储键，批次与停用结论是质量域专属数据，
 * 单独存两个 localStorage 键，避免污染通用 CRUD 层。
 */

export const QUALITY_MODULE_KEY = 'quality'
export const SEARCH_MODULE_KEY = 'search'
const MAIN_STORAGE_KEY = 'lake-govern-config:entries'
const BATCH_STORAGE_KEY = 'lake-govern-config:quality-batches'
const CONCLUSION_STORAGE_KEY = 'lake-govern-config:quality-deactivations'

export type BatchStatus = '进行中' | '已关闭'

export type QualityBatchRow = {
  id: number
  批次编号: string
  指标编号: string
  监控对象: string
  检测周期: string
  批次状态: BatchStatus
  告警级别: string
  阈值范围: string
  异常数量: number
  生成时间: string
  关闭时间: string | null
  只读: boolean
}

export type IndexWritebackState = {
  索引编号: string
  状态: '待同步' | '已同步'
  同步时间: string | null
}

export type BatchSnapshot = {
  批次编号: string
  批次状态: BatchStatus
  告警级别: string
  异常数量: number
}

export type DeactivationConclusion = {
  指标编号: string
  停用时间: string
  /** 旧口径：停用时含已关闭批次在内的累计异常数，作为只读证据保留，不再清零。 */
  历史告警数: number
  /** 新口径：停用后有效告警恒为 0，下游索引只读取当前有效指标。 */
  有效告警数: number
  批次快照: BatchSnapshot[]
  索引写回: IndexWritebackState[]
}

/** 检索索引 → 质量指标 的关联关系：跨模块调用链就靠这张表串起来。编号口径与种子数据一致。 */
export const INDEX_METRIC_LINKS: Record<string, string> = {
  'SEAR-0002': 'QUAL-0003',
  'SEAR-0003': 'QUAL-0003',
}

/** 老数据里索引残留的历史告警数：只作为证据基线，后续只增不清零。 */
const INDEX_LEGACY_ALARMS: Record<string, number> = {
  'SEAR-0002': 3,
}

/**
 * 批次示例数据：已启用指标 QUAL-0003 同时有已关闭的历史批次和进行中的批次，
 * 用来演示「已关闭批次不能再算进当前有效告警」。
 */
export const SEED_BATCHES: QualityBatchRow[] = [
  {
    id: 1,
    批次编号: 'QBAT-20260901-001',
    指标编号: 'QUAL-0003',
    监控对象: '质量监控样例3',
    检测周期: '每日',
    批次状态: '已关闭',
    告警级别: '严重',
    阈值范围: '质量监控样例3',
    异常数量: 5,
    生成时间: '2026-09-01 08:00',
    关闭时间: '2026-09-01 09:00',
    只读: true,
  },
  {
    id: 2,
    批次编号: 'QBAT-20260915-001',
    指标编号: 'QUAL-0003',
    监控对象: '质量监控样例3',
    检测周期: '每日',
    批次状态: '进行中',
    告警级别: '警告',
    阈值范围: '质量监控样例3',
    异常数量: 2,
    生成时间: '2026-09-15 08:00',
    关闭时间: null,
    只读: false,
  },
]

export function nowText(): string {
  const d = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

function readJson<T>(key: string, fallback: T): T {
  if (typeof window === 'undefined' || !window.localStorage) {
    return fallback
  }
  const raw = window.localStorage.getItem(key)
  if (!raw) {
    window.localStorage.setItem(key, JSON.stringify(fallback))
    return fallback
  }
  try {
    return JSON.parse(raw) as T
  } catch {
    window.localStorage.setItem(key, JSON.stringify(fallback))
    return fallback
  }
}

let batchCache: QualityBatchRow[] | null = null
let conclusionCache: Record<string, DeactivationConclusion> | null = null

if (typeof window !== 'undefined') {
  // 另一个标签页写过后，本标签页缓存作废，保证并发停用判定读到的是最新结论。
  window.addEventListener('storage', (event) => {
    if (event.key === BATCH_STORAGE_KEY) {
      batchCache = null
    }
    if (event.key === CONCLUSION_STORAGE_KEY || event.key === MAIN_STORAGE_KEY) {
      conclusionCache = null
    }
  })
}

export function listQualityBatches(): QualityBatchRow[] {
  if (batchCache === null) {
    batchCache = readJson<QualityBatchRow[]>(BATCH_STORAGE_KEY, SEED_BATCHES)
  }
  return batchCache
}

export function saveQualityBatches(rows: QualityBatchRow[]): void {
  batchCache = rows
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.setItem(BATCH_STORAGE_KEY, JSON.stringify(rows))
  }
}

export function listConclusions(): Record<string, DeactivationConclusion> {
  if (conclusionCache === null) {
    conclusionCache = readJson<Record<string, DeactivationConclusion>>(CONCLUSION_STORAGE_KEY, {})
  }
  return conclusionCache
}

export function getConclusion(metricCode: string): DeactivationConclusion | null {
  return listConclusions()[metricCode] ?? null
}

export function saveConclusion(conclusion: DeactivationConclusion): void {
  const next = { ...listConclusions(), [conclusion.指标编号]: conclusion }
  conclusionCache = next
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.setItem(CONCLUSION_STORAGE_KEY, JSON.stringify(next))
  }
}

export function resetQualityDomain(): void {
  batchCache = null
  conclusionCache = null
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.removeItem(BATCH_STORAGE_KEY)
    window.localStorage.removeItem(CONCLUSION_STORAGE_KEY)
  }
}

export function nextBatchId(rows: QualityBatchRow[]): number {
  return rows.reduce((max, row) => Math.max(max, Number(row.id)), 0) + 1
}

/** 指标行补齐领域字段：纯函数，老 localStorage 数据读出来时幂等兜底，首次领域写回时落盘。 */
export function ensureQualityRow(row: EntryRow): EntryRow {
  return {
    ...row,
    停用时间: typeof row.停用时间 === 'string' ? row.停用时间 : '',
    version: typeof row.version === 'number' ? row.version : 0,
  }
}

/** 索引行补齐跨模块告警字段：历史告警数只取证据基线，绝不在刷新时被清零。 */
export function ensureSearchRow(row: EntryRow): EntryRow {
  const code = String(row.索引编号 ?? '')
  return {
    ...row,
    关联指标: INDEX_METRIC_LINKS[code] ?? (typeof row.关联指标 === 'string' ? row.关联指标 : ''),
    历史告警数:
      typeof row.历史告警数 === 'number' ? row.历史告警数 : INDEX_LEGACY_ALARMS[code] ?? 0,
    当前有效告警数: typeof row.当前有效告警数 === 'number' ? row.当前有效告警数 : 0,
    指标状态: typeof row.指标状态 === 'string' ? row.指标状态 : '',
    停用结论: typeof row.停用结论 === 'string' ? row.停用结论 : '',
  }
}

/** 绕过缓存直接读主存储：并发停用时必须以磁盘上的最新版本号为准，不能信本标签页旧缓存。 */
export function readRawEntries(): Record<string, EntryRow[]> {
  if (typeof window === 'undefined' || !window.localStorage) {
    return {}
  }
  const raw = window.localStorage.getItem(MAIN_STORAGE_KEY)
  if (!raw) {
    return {}
  }
  try {
    return JSON.parse(raw) as Record<string, EntryRow[]>
  } catch {
    return {}
  }
}
