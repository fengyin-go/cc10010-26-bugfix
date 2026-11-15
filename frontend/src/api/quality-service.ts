import { invalidateCache, saveRows } from '@/data/local-store'
import {
  BatchSnapshot,
  DeactivationConclusion,
  INDEX_METRIC_LINKS,
  QualityBatchRow,
  SEARCH_MODULE_KEY,
  ensureQualityRow,
  ensureSearchRow,
  getConclusion,
  listConclusions,
  listQualityBatches,
  nextBatchId,
  nowText,
  readRawEntries,
  resetQualityDomain,
  saveConclusion,
  saveQualityBatches,
} from '@/data/quality-domain'
import type { ActionResult, EntryRow } from '@/data/types'

/**
 * 质量监控领域服务：状态流转只允许在这里改（与 local-service 的约定一致）。
 * 调用链：监控对象（质量指标）→ 检测批次 → 检索索引状态。
 */

const QUALITY_STATUS_FLOW = ['草稿', '待校验', '已启用', '已停用'] as const

function assertForwardOnly(current: string, target: string): ActionResult | null {
  const from = QUALITY_STATUS_FLOW.indexOf(current as (typeof QUALITY_STATUS_FLOW)[number])
  const to = QUALITY_STATUS_FLOW.indexOf(target as (typeof QUALITY_STATUS_FLOW)[number])
  if (to < 0) {
    return { ok: false, message: `质量指标没有「${target}」这个状态` }
  }
  // 状态只能按 草稿→待校验→已启用→已停用 推进，禁止倒序恢复。
  if (from >= 0 && to <= from) {
    return {
      ok: false,
      message: `状态只能按「${QUALITY_STATUS_FLOW.join('→')}」单向推进，当前「${current}」不能回退到「${target}」`,
    }
  }
  return null
}

function loadQualityRows(): EntryRow[] {
  const raw = readRawEntries().quality ?? []
  return raw.map(ensureQualityRow)
}

function findQualityRow(rows: EntryRow[], id: number): EntryRow | undefined {
  return rows.find((row) => Number(row.id) === id)
}

function findIndexByCode(rows: EntryRow[], code: string): number {
  return rows.findIndex((row) => String(row.索引编号) === code)
}

function batchesOf(metricCode: string): QualityBatchRow[] {
  return listQualityBatches().filter((batch) => batch.指标编号 === metricCode)
}

/** 当前有效告警：停用后不新建批次，且只统计启用指标的进行中批次。已关闭批次是历史证据，不计入。 */
export function effectiveAlarmCount(metricCode: string, metricStatus: string): number {
  if (metricStatus !== '已启用') {
    return 0
  }
  return batchesOf(metricCode)
    .filter((batch) => batch.批次状态 === '进行中')
    .reduce((sum, batch) => sum + batch.异常数量, 0)
}

/** 旧口径累计：含已关闭批次在内的全部历史异常，停用结论里作为只读证据保留。 */
export function historicalAlarmCount(metricCode: string): number {
  const conclusion = getConclusion(metricCode)
  if (conclusion) {
    return conclusion.历史告警数
  }
  return batchesOf(metricCode).reduce((sum, batch) => sum + batch.异常数量, 0)
}

export type QualityStat = {
  total: number
  enabled: number
  pendingReview: number
  deactivated: number
  effectiveAlarms: number
  historicalAlarms: number
}

export function qualityStats(rows: EntryRow[]): QualityStat {
  return {
    total: rows.length,
    enabled: rows.filter((row) => row.status === '已启用').length,
    pendingReview: rows.filter((row) => row.status === '待校验').length,
    deactivated: rows.filter((row) => row.status === '已停用').length,
    effectiveAlarms: rows.reduce(
      (sum, row) => sum + effectiveAlarmCount(String(row.指标编号), String(row.status)),
      0,
    ),
    historicalAlarms: rows.reduce((sum, row) => sum + historicalAlarmCount(String(row.指标编号)), 0),
  }
}

export type AlarmDetail = {
  指标编号: string
  监控对象: string
  告警级别: string
  阈值范围: string
  当前有效异常: number
  历史累计异常: number
  口径偏差: number
  来源批次: { 批次编号: string; 批次状态: string; 异常数量: number }[]
  停用时间: string
  说明: string
}

/** 告警详情：异常数量按新口径给，新老统计有偏差时逐批指明来源批次，旧阈值结论按原口径保留。 */
export function alarmDetail(row: EntryRow): AlarmDetail {
  const code = String(row.指标编号)
  const effective = effectiveAlarmCount(code, String(row.status))
  const historical = historicalAlarmCount(code)
  const conclusion = getConclusion(code)
  const snapshots = (conclusion?.批次快照 ?? batchesOf(code).map((b) => ({
    批次编号: b.批次编号,
    批次状态: b.批次状态,
    告警级别: b.告警级别,
    异常数量: b.异常数量,
  }))) as BatchSnapshot[]
  return {
    指标编号: code,
    监控对象: String(row.监控对象 ?? ''),
    告警级别: String(row.告警级别 ?? ''),
    阈值范围: String(row.阈值范围 ?? ''),
    当前有效异常: effective,
    历史累计异常: historical,
    口径偏差: historical - effective,
    来源批次: snapshots.map((s) => ({
      批次编号: s.批次编号,
      批次状态: s.批次状态,
      异常数量: s.异常数量,
    })),
    停用时间: conclusion?.停用时间 ?? '',
    说明:
      row.status === '已停用'
        ? `指标已于${conclusion?.停用时间 ?? ''}停用，有效告警以新口径计为 0；旧阈值结论与累计异常按原口径保留为只读证据。`
        : '有效异常只统计进行中批次；已关闭批次作为历史证据，不计入当前告警。',
  }
}

/** 提交校验：只有启用中的指标才继续产生检测；已停用指标的校验请求直接拒绝并写明停用时间。 */
export function runQualityCheck(row: EntryRow): ActionResult {
  if (row.status === '已停用') {
    const conclusion = getConclusion(String(row.指标编号))
    return {
      ok: false,
      message: `指标${row.指标编号}已于${conclusion?.停用时间 ?? String(row.停用时间 ?? '早前')}停用，待校验流程不再产生新的报错与批次`,
    }
  }
  if (row.status !== '已启用') {
    return { ok: false, message: `指标${row.指标编号}当前为「${row.status}」，启用后才会产生检测批次` }
  }
  const rows = listQualityBatches()
  const batch: QualityBatchRow = {
    id: nextBatchId(rows),
    批次编号: `QBAT-${Date.now()}`,
    指标编号: String(row.指标编号),
    监控对象: String(row.监控对象 ?? ''),
    检测周期: String(row.检测周期 ?? ''),
    批次状态: '进行中',
    告警级别: String(row.告警级别 ?? ''),
    阈值范围: String(row.阈值范围 ?? ''),
    异常数量: 0,
    生成时间: nowText(),
    关闭时间: null,
    只读: false,
  }
  saveQualityBatches([...rows, batch])
  return { ok: true, message: `指标${row.指标编号}已生成检测批次${batch.批次编号}` }
}

function snapshotBatches(metricCode: string): BatchSnapshot[] {
  return batchesOf(metricCode).map((b) => ({
    批次编号: b.批次编号,
    批次状态: b.批次状态,
    告警级别: b.告警级别,
    异常数量: b.异常数量,
  }))
}

function linkedIndexCodes(metricCode: string): string[] {
  return Object.entries(INDEX_METRIC_LINKS)
    .filter(([, metric]) => metric === metricCode)
    .map(([indexCode]) => indexCode)
}

/**
 * 停用指标：监控对象 → 批次 → 索引的完整链路。
 * 1) 读磁盘最新行做版本号比对：两个标签页同时停用时只有首个结果落盘，后到的按并发冲突拒绝。
 * 2) 停用后不再新建批次，进行中批次全部关闭并转只读，历史告警不清零。
 * 3) 跨模块索引状态清单随停用结论更新；写回中断则从尚未更新的索引继续。
 */
export function deactivateMetric(id: number, expectedVersion?: number): ActionResult {
  const rawEntries = readRawEntries()
  const qualityRows = (rawEntries.quality ?? []).map(ensureQualityRow)
  const row = findQualityRow(qualityRows, id)
  if (!row) {
    return { ok: false, message: `没有找到编号为 ${id} 的质量指标` }
  }
  const currentVersion = typeof row.version === 'number' ? row.version : 0
  if (expectedVersion !== undefined && expectedVersion !== currentVersion) {
    return {
      ok: false,
      message: `指标${row.指标编号}已被另一个标签页更新（版本 ${expectedVersion} → ${currentVersion}），本次停用结果不接受`,
    }
  }
  if (row.status === '已停用') {
    const conclusion = getConclusion(String(row.指标编号))
    return {
      ok: false,
      message: `指标${row.指标编号}已于${conclusion?.停用时间 ?? String(row.停用时间 ?? '早前')}停用，不能重复停用，也不能倒序恢复`,
    }
  }
  const forwardError = assertForwardOnly(String(row.status), '已停用')
  if (forwardError) {
    return forwardError
  }

  const metricCode = String(row.指标编号)
  const stopTime = nowText()

  // ① 批次：进行中批次关闭并转只读；历史告警（含已关闭批次）原样保留，绝不清零。
  const batches = listQualityBatches()
  let historical = 0
  const nextBatches = batches.map((batch) => {
    if (batch.指标编号 !== metricCode) {
      return batch
    }
    historical += batch.异常数量
    if (batch.批次状态 === '进行中') {
      return { ...batch, 批次状态: '已关闭' as const, 关闭时间: stopTime, 只读: true }
    }
    return { ...batch, 只读: true }
  })
  saveQualityBatches(nextBatches)

  // ② 停用结论：旧口径累计与批次快照作为只读证据固定下来。
  const indexCodes = linkedIndexCodes(metricCode)
  const existing = getConclusion(metricCode)
  const conclusion: DeactivationConclusion = {
    指标编号: metricCode,
    停用时间: stopTime,
    历史告警数: historical,
    有效告警数: 0,
    批次快照: snapshotBatches(metricCode),
    索引写回: indexCodes.map((code) => {
      const prior = existing?.索引写回.find((item) => item.索引编号 === code)
      return prior ?? { 索引编号: code, 状态: '待同步' as const, 同步时间: null }
    }),
  }
  saveConclusion(conclusion)

  // ③ 指标行落盘：停用后异常标记撤销，避免列表仍显示成旧告警；版本号 +1 供并发判定。
  const nextQualityRows = qualityRows.map((item) =>
    Number(item.id) === id
      ? {
          ...item,
          status: '已停用',
          pending: false,
          abnormal: false,
          停用时间: stopTime,
          version: currentVersion + 1,
        }
      : item,
  )
  saveRows('quality', nextQualityRows)
  // 作废通用层缓存：本函数前面是绕过缓存读的磁盘数据，强制后续 listRows 重新从存储装载。
  invalidateCache()

  // ④ 跨模块索引状态清单随停用结论更新；单个索引写回失败不影响已落盘结论，可断点续跑。
  const writeback = writeIndexStatus(metricCode, stopTime)
  const failed = writeback.filter((item) => !item.ok)
  if (failed.length > 0) {
    return {
      ok: true,
      message: `指标${metricCode}已于${stopTime}停用；索引写回中断（${failed.map((f) => f.code).join('、')} 未更新），可从尚未更新的索引继续，历史告警未清零`,
    }
  }
  return {
    ok: true,
    message: `指标${metricCode}已于${stopTime}停用，进行中批次已关闭转只读，关联索引已按停用结论更新，历史告警保留为只读证据`,
  }
}

type WritebackResult = { code: string; ok: boolean }

/** 索引写回：只更新结论里仍处于「待同步」的索引，已同步的不重复处理，实现中断后从断点继续。 */
export function writeIndexStatus(metricCode: string, stopTime?: string): WritebackResult[] {
  const conclusion = getConclusion(metricCode)
  if (!conclusion) {
    return []
  }
  const rawEntries = readRawEntries()
  const searchRows = (rawEntries[SEARCH_MODULE_KEY] ?? []).map(ensureSearchRow)
  const time = stopTime ?? conclusion.停用时间
  const results: WritebackResult[] = []
  const nextSearchRows = [...searchRows]
  let changed = false

  for (const item of conclusion.索引写回) {
    if (item.状态 === '已同步') {
      results.push({ code: item.索引编号, ok: true })
      continue
    }
    const index = findIndexByCode(nextSearchRows, item.索引编号)
    if (index < 0) {
      results.push({ code: item.索引编号, ok: false })
      continue
    }
    try {
      const current = ensureSearchRow(nextSearchRows[index])
      const legacyAlarm =
        typeof current.历史告警数 === 'number'
          ? Number(current.历史告警数)
          : batchesOf(metricCode).reduce((sum, b) => sum + b.异常数量, 0)
      nextSearchRows[index] = {
        ...current,
        // 下游索引只读取当前有效指标：指标停用后有效告警恒为 0；历史告警保留不清零。
        当前有效告警数: 0,
        历史告警数: legacyAlarm,
        指标状态: '已停用',
        停用结论: `关联指标${metricCode}已于${time}停用，仅保留历史告警证据`,
        abnormal: false,
      }
      item.状态 = '已同步'
      item.同步时间 = nowText()
      changed = true
      results.push({ code: item.索引编号, ok: true })
    } catch {
      results.push({ code: item.索引编号, ok: false })
    }
  }

  if (changed) {
    saveRows(SEARCH_MODULE_KEY, nextSearchRows)
    invalidateCache()
  }
  saveConclusion({ ...conclusion })
  return results
}

/** 通用动作入口：质量指标的状态流转统一收口到本服务，保证单向推进与停用链路。 */
export function applyQualityAction(id: number, action: string, row: EntryRow): ActionResult {
  if (action === '停用监控') {
    return deactivateMetric(id, typeof row.version === 'number' ? row.version : 0)
  }
  const targetMap: Record<string, string> = {
    提交校验: '待校验',
    启用监控: '已启用',
  }
  const target = targetMap[action]
  if (!target) {
    return { ok: false, message: `质量指标没有登记「${action}」这个动作` }
  }
  const forwardError = assertForwardOnly(String(row.status), target)
  if (forwardError) {
    return forwardError
  }
  if (action === '提交校验' && row.status !== '草稿') {
    return { ok: false, message: `指标当前为「${row.status}」，只有草稿指标能提交校验` }
  }
  if (action === '启用监控' && row.status !== '待校验') {
    return { ok: false, message: `指标当前为「${row.status}」，只有待校验指标能启用监控` }
  }
  const rawEntries = readRawEntries()
  const qualityRows = (rawEntries.quality ?? []).map(ensureQualityRow)
  const currentVersion = typeof row.version === 'number' ? row.version : 0
  const nextRows = qualityRows.map((item) =>
    Number(item.id) === id
      ? {
          ...item,
          status: target,
          pending: target !== '已停用',
          abnormal: false,
          version: currentVersion + 1,
        }
      : item,
  )
  saveRows('quality', nextRows)
  invalidateCache()
  return { ok: true, message: `质量指标已${action}，当前状态「${target}」` }
}

export type IndexQualityView = {
  row: EntryRow
  linkedMetric: string
  effectiveAlarms: number
  historicalAlarms: number
  writebackState: '待同步' | '已同步' | '无关联'
  deactivationTime: string
}

/** 数据检索页面读取的跨模块索引状态清单：随本次停用结论实时计算。 */
export function listIndexQualityStatus(rows: EntryRow[]): IndexQualityView[] {
  const conclusions = listConclusions()
  return rows.map((rawRow) => {
    const row = ensureSearchRow(rawRow)
    const code = String(row.索引编号 ?? '')
    const linkedMetric = String(row.关联指标 ?? '')
    const conclusion = linkedMetric ? conclusions[linkedMetric] : undefined
    const writeback = conclusion?.索引写回.find((item) => item.索引编号 === code)
    const metricRow =
      linkedMetric ? loadQualityRows().find((item) => String(item.指标编号) === linkedMetric) : undefined
    const effective = linkedMetric
      ? effectiveAlarmCount(linkedMetric, String(metricRow?.status ?? ''))
      : 0
    return {
      row,
      linkedMetric,
      effectiveAlarms: effective,
      historicalAlarms: Number(row.历史告警数 ?? 0),
      writebackState: !linkedMetric ? '无关联' : writeback?.状态 ?? '待同步',
      deactivationTime: conclusion?.停用时间 ?? '',
    }
  })
}

export function batchesForMetric(metricCode: string): QualityBatchRow[] {
  return listQualityBatches()
    .filter((batch) => batch.指标编号 === metricCode)
    .sort((a, b) => b.id - a.id)
}

export function resetQualityData(): void {
  resetQualityDomain()
}
