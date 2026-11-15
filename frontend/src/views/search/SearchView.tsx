import { useCallback, useEffect, useMemo, useState } from 'react'

import { downloadEntries, listEntries, moduleMeta } from '@/api/local-service'
import { listIndexQualityStatus, writeIndexStatus } from '@/api/quality-service'
import { INDEX_METRIC_LINKS, ensureSearchRow } from '@/data/quality-domain'
import type { EntryRow } from '@/data/types'

const meta = moduleMeta('search')
const baseColumns = [
  "索引编号",
  "索引名称",
  "覆盖表名",
  "索引字段",
  "分词策略",
  "排序权重",
  "刷新频率",
  "索引大小"
]
const actions = [
  "提交构建",
  "启用索引",
  "标记失效"
]
const statuses = [
  "草稿",
  "待构建",
  "已生效",
  "已失效"
]

export default function SearchView() {
  const [rows, setRows] = useState<EntryRow[]>([])
  const [total, setTotal] = useState(0)
  const [errorMessage, setErrorMessage] = useState('')
  const [notice, setNotice] = useState('')
  const [filters, setFilters] = useState<Record<string, string>>({})
  const filterFields = useMemo(() => baseColumns.slice(0, 3), [])

  const reload = useCallback(() => {
    setErrorMessage('')
    try {
      const payload = listEntries(meta.key, filters)
      setRows(payload.items.map((row) => ensureSearchRow(row)))
      setTotal(payload.total)
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : '数据检索列表读取失败')
    }
  }, [filters])

  useEffect(() => {
    reload()
  }, [reload])

  // 跨模块索引状态清单：随质量指标的停用结论实时更新，只读取当前有效指标。
  const indexStatus = useMemo(() => listIndexQualityStatus(rows), [rows])

  const statCards = useMemo(() => [
    { label: '检索索引总数', value: rows.length },
    { label: '已生效索引', value: rows.filter((row) => row.status === '已生效').length },
    { label: '待构建索引', value: rows.filter((row) => row.status === '待构建').length },
    { label: '当前有效告警（仅有效指标）', value: indexStatus.reduce((sum, item) => sum + item.effectiveAlarms, 0) },
    { label: '残留历史告警（只读证据）', value: indexStatus.reduce((sum, item) => sum + item.historicalAlarms, 0) },
  ], [rows, indexStatus])

  function resumeWriteback(metricCode: string) {
    setErrorMessage('')
    setNotice('')
    // 写回中断后从结论里仍为「待同步」的索引继续，已同步的不重复处理，历史告警不会被清零。
    const results = writeIndexStatus(metricCode)
    const failed = results.filter((item) => !item.ok)
    if (results.length === 0) {
      setErrorMessage(`指标${metricCode}暂无停用结论，无需写回`)
      return
    }
    if (failed.length > 0) {
      setErrorMessage(`索引${failed.map((f) => f.code).join('、')}写回仍失败，其余索引已更新，可再次续跑`)
    } else {
      setNotice(`指标${metricCode}关联索引已全部按停用结论更新完成，历史告警保留未清零`)
    }
    reload()
  }

  return (
    <section className="page" data-module="search">
      <header className="page-head">
        <div>
          <h2>数据检索管理</h2>
          <p className="page-desc">索引状态清单随质量指标停用结论联动：下游索引只读取当前有效指标，历史告警只作只读证据。</p>
        </div>
        <div className="page-actions">
          <button className="btn primary" type="button" onClick={() => setErrorMessage('检索索引登记入口尚未接入审批流')}>
            登记检索索引
          </button>
          <button className="btn" type="button" onClick={() => downloadEntries(meta.key)}>
            导出数据检索清单
          </button>
        </div>
      </header>

      <div className="stat-row">
        {statCards.map((item) => (
          <article key={item.label} className="stat-card">
            <span className="stat-label">{item.label}</span>
            <strong className="stat-value">{item.value}</strong>
          </article>
        ))}
      </div>

      <p className="status-legend">
        {statuses.map((status: string) => (
          <span key={status} className="legend-item">
            {status}：{rows.filter((row) => String(row.status) === status).length}
          </span>
        ))}
      </p>

      <form className="filter-bar" onSubmit={(event) => { event.preventDefault(); reload() }}>
        {filterFields.map((field) => (
          <label key={field} className="filter-item">
            <span>{field}</span>
            <input
              value={filters[field] ?? ''}
              placeholder={`按${field}检索`}
              onChange={(event) => setFilters((prev) => ({ ...prev, [field]: event.target.value }))}
            />
          </label>
        ))}
        <button className="btn" type="submit">查询</button>
        <button className="btn ghost" type="button" onClick={() => setFilters({})}>重置条件</button>
      </form>

      <table className="data-table">
        <thead>
          <tr>
            {baseColumns.map((column) => <th key={column}>{column}</th>)}
            <th>当前状态</th>
            <th>关联质量指标</th>
            <th>当前有效告警</th>
            <th>历史告警证据</th>
            <th>停用结论写回</th>
            <th>可执行动作</th>
          </tr>
        </thead>
        <tbody>
          {indexStatus.map(({ row, linkedMetric, effectiveAlarms, historicalAlarms, writebackState, deactivationTime }) => (
            <tr key={String(row.id)}>
              {baseColumns.map((column) => <td key={column}>{row[column] ?? '—'}</td>)}
              <td>{row.status}</td>
              <td>{linkedMetric || '—'}</td>
              <td>
                {linkedMetric ? (
                  <span className={`badge ${effectiveAlarms > 0 ? 'badge-alarm' : 'badge-synced'}`}>
                    {effectiveAlarms}
                  </span>
                ) : '—'}
              </td>
              <td>
                {/* 历史告警是旧口径证据：停用写回时保留基线，只增不清零，不再展示成当前告警 */}
                {linkedMetric ? (
                  <span className="badge badge-evidence" title={String(row.停用结论 ?? '')}>
                    {historicalAlarms}
                  </span>
                ) : '—'}
              </td>
              <td>
                {!linkedMetric && '—'}
                {linkedMetric && writebackState === '已同步' && (
                  <span className="badge badge-synced">已同步（{deactivationTime}）</span>
                )}
                {linkedMetric && writebackState === '待同步' && (
                  <span className="badge badge-pending">待同步 · 旧告警残留</span>
                )}
              </td>
              <td className="row-actions">
                {actions.map((action) => (
                  <button
                    key={action}
                    className="link"
                    type="button"
                    onClick={() => setErrorMessage('检索索引动作沿用通用审批流，本页聚焦停用结论联动状态')}
                  >
                    {action}
                  </button>
                ))}
                {linkedMetric && writebackState === '待同步' && (
                  <button className="link" type="button" onClick={() => resumeWriteback(linkedMetric)}>
                    继续写回索引
                  </button>
                )}
              </td>
            </tr>
          ))}
          {rows.length === 0 && (
            <tr>
              <td className="empty-state" colSpan={baseColumns.length + 6}>暂无数据检索数据，可先登记检索索引</td>
            </tr>
          )}
        </tbody>
      </table>

      <footer className="page-foot">
        <span>共 {total} 条数据检索记录；关联关系：{Object.entries(INDEX_METRIC_LINKS).map(([indexCode, metric]) => `${indexCode}→${metric}`).join('，')}</span>
        {notice && <span className="badge badge-synced">{notice}</span>}
        {errorMessage && <span className="error-text">{errorMessage}</span>}
      </footer>
    </section>
  )
}
