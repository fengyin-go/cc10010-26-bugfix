import { useCallback, useEffect, useMemo, useState } from 'react'

import { downloadEntries, listEntries, moduleMeta, runAction as applyAction } from '@/api/local-service'
import {
  alarmDetail,
  batchesForMetric,
  deactivateMetric,
  qualityStats,
  runQualityCheck,
} from '@/api/quality-service'
import type { EntryRow } from '@/data/types'

const meta = moduleMeta('quality')
const columns = [
  "指标编号",
  "监控对象",
  "指标类型",
  "阈值范围",
  "检测周期",
  "告警级别",
  "通知渠道",
  "恢复策略"
]
const flowStatuses = ["草稿", "待校验", "已启用", "已停用"]

// 只允许状态正向推进的动作矩阵：停用态没有任何后续动作，倒序恢复入口不渲染。
const NEXT_ACTIONS: Record<string, string[]> = {
  "草稿": ["提交校验"],
  "待校验": ["启用监控"],
  "已启用": ["停用监控", "产生检测批次"],
  "已停用": [],
}

export default function QualityView() {
  const [rows, setRows] = useState<EntryRow[]>([])
  const [total, setTotal] = useState(0)
  const [errorMessage, setErrorMessage] = useState('')
  const [notice, setNotice] = useState('')
  const [filters, setFilters] = useState<Record<string, string>>({})
  const [selectedCode, setSelectedCode] = useState<string>('')
  const filterFields = useMemo(() => columns.slice(0, 3), [])

  const reload = useCallback(() => {
    setErrorMessage('')
    try {
      const payload = listEntries(meta.key, filters)
      setRows(payload.items)
      setTotal(payload.total)
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : '质量监控列表读取失败')
    }
  }, [filters])

  useEffect(() => {
    reload()
  }, [reload])

  const stats = useMemo(() => qualityStats(rows), [rows])
  const statCards = [
    { label: '质量指标总数', value: stats.total },
    { label: '已启用指标', value: stats.enabled },
    { label: '待校验指标', value: stats.pendingReview },
    { label: '已停用指标', value: stats.deactivated },
    { label: '当前有效告警', value: stats.effectiveAlarms },
    { label: '历史告警证据（只读）', value: stats.historicalAlarms },
  ]

  const selectedRow = useMemo(
    () => rows.find((row) => String(row.指标编号) === selectedCode),
    [rows, selectedCode],
  )
  const selectedBatches = useMemo(
    () => (selectedCode ? batchesForMetric(selectedCode) : []),
    [selectedCode, rows],
  )
  const selectedDetail = useMemo(
    () => (selectedRow ? alarmDetail(selectedRow) : null),
    [selectedRow],
  )

  function runAction(action: string, row: EntryRow) {
    setErrorMessage('')
    setNotice('')
    if (action === '产生检测批次') {
      const result = runQualityCheck(row)
      if (!result.ok) {
        setErrorMessage(result.message)
      } else {
        setNotice(result.message)
      }
      reload()
      return
    }
    if (action === '停用监控') {
      // 直接把当前行版本号传给领域服务：另一标签页先停用时版本对不上，本次结果会被拒绝。
      const result = deactivateMetric(Number(row.id), typeof row.version === 'number' ? row.version : 0)
      if (!result.ok) {
        setErrorMessage(result.message)
        return
      }
      setNotice(result.message)
      reload()
      return
    }
    const result = applyAction(meta.key, Number(row.id), action)
    if (!result.ok) {
      setErrorMessage(result.message)
      return
    }
    setNotice(result.message)
    reload()
  }

  return (
    <section className="page" data-module="quality">
      <header className="page-head">
        <div>
          <h2>质量监控管理</h2>
          <p className="page-desc">监控对象 → 检测批次 → 检索索引状态的完整调用链；停用后不再新建批次，历史告警转为只读证据。</p>
        </div>
        <div className="page-actions">
          <button className="btn primary" type="button" onClick={() => setErrorMessage('质量指标登记入口尚未接入审批流')}>
            登记质量指标
          </button>
          <button className="btn" type="button" onClick={() => downloadEntries(meta.key)}>
            导出质量监控清单
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
        {flowStatuses.map((status: string) => (
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
            {columns.map((column) => <th key={column}>{column}</th>)}
            <th>当前状态</th>
            <th>当前有效异常</th>
            <th>历史告警证据</th>
            <th>停用时间</th>
            <th>可执行动作</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={String(row.id)}>
                {columns.map((column) => <td key={column}>{row[column] ?? '—'}</td>)}
                <td>
                  {row.status}
                  {row.status === '已停用' && (
                    <span className="badge badge-evidence" style={{ marginLeft: 6 }}>历史证据</span>
                  )}
                </td>
                <td>
                  {row.status === '已停用' ? (
                    <span className="badge badge-synced">0（停用后无有效告警）</span>
                  ) : (
                    <span className="badge badge-alarm">
                      {batchesForMetric(String(row.指标编号))
                        .filter((b) => b.批次状态 === '进行中')
                        .reduce((sum, b) => sum + b.异常数量, 0)}
                    </span>
                  )}
                </td>
                <td>
                  {/* 旧阈值结论与告警级别按原口径保留，只作只读证据，不再参与当前告警统计 */}
                  <span className="badge badge-evidence" title={`原阈值范围：${String(row.阈值范围 ?? '')}`}>
                    {String(row.告警级别 ?? '')} / 累计 {alarmDetail(row).历史累计异常}
                  </span>
                </td>
                <td>{row.status === '已停用' ? String(row.停用时间 ?? '—') : '—'}</td>
                <td className="row-actions">
                  {NEXT_ACTIONS[String(row.status)]?.map((action) => (
                    <button key={action} className="link" type="button" onClick={() => runAction(action, row)}>
                      {action}
                    </button>
                  ))}
                  {NEXT_ACTIONS[String(row.status)]?.length === 0 && (
                    <button
                      className="link"
                      type="button"
                      title={`指标已于${String(row.停用时间 ?? '早前')}停用，状态不能倒序恢复`}
                      onClick={() => setErrorMessage(`指标${row.指标编号}已于${String(row.停用时间 ?? '早前')}停用，不能重复停用或倒序恢复`)}
                    >
                      查看停用结论
                    </button>
                  )}
                  <button className="link" type="button" onClick={() => setSelectedCode(String(row.指标编号))}>
                    告警详情
                  </button>
                </td>
              </tr>
          ))}
          {rows.length === 0 && (
            <tr>
              <td className="empty-state" colSpan={columns.length + 5}>暂无质量监控数据，可先登记质量指标</td>
            </tr>
          )}
        </tbody>
      </table>

      {selectedDetail && (
        <div className="detail-panel">
          <h3>
            告警详情 · {selectedDetail.指标编号}（{selectedDetail.监控对象}）
            <button className="btn ghost" type="button" style={{ float: 'right' }} onClick={() => setSelectedCode('')}>关闭</button>
          </h3>
          <dl className="detail-grid">
            <div><dt>当前有效异常（新口径）</dt><dd><strong>{selectedDetail.当前有效异常}</strong></dd></div>
            <div><dt>历史累计异常（旧口径只读）</dt><dd>{selectedDetail.历史累计异常}</dd></div>
            <div><dt>口径偏差</dt><dd>{selectedDetail.口径偏差}</dd></div>
            <div><dt>停用时间</dt><dd>{selectedDetail.停用时间 || '未停用'}</dd></div>
            <div><dt>原告警级别（按原口径保留）</dt><dd>{selectedDetail.告警级别}</dd></div>
            <div><dt>原阈值范围（按原口径保留）</dt><dd>{selectedDetail.阈值范围}</dd></div>
          </dl>
          <h4>异常来源批次（偏差逐批可追溯）</h4>
          <table className="data-table">
            <thead>
              <tr><th>批次编号</th><th>批次状态</th><th>异常数量</th><th>是否计入当前有效告警</th></tr>
            </thead>
            <tbody>
              {selectedDetail.来源批次.length === 0 && (
                <tr><td className="empty-state" colSpan={4}>该指标暂无检测批次</td></tr>
              )}
              {selectedDetail.来源批次.map((batch) => (
                <tr key={batch.批次编号}>
                  <td>{batch.批次编号}</td>
                  <td>
                    <span className={`badge ${batch.批次状态 === '进行中' ? 'badge-open' : 'badge-closed'}`}>
                      {batch.批次状态}
                    </span>
                  </td>
                  <td>{batch.异常数量}</td>
                  <td>{batch.批次状态 === '进行中' ? '计入' : '不计入（历史证据）'}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <h4>检测批次记录（停用后已关闭批次只读，不再新建批次）</h4>
          <table className="data-table">
            <thead>
              <tr><th>批次编号</th><th>批次状态</th><th>告警级别</th><th>异常数量</th><th>生成时间</th><th>关闭时间</th><th>只读</th></tr>
            </thead>
            <tbody>
              {selectedBatches.length === 0 && (
                <tr><td className="empty-state" colSpan={7}>暂无批次记录</td></tr>
              )}
              {selectedBatches.map((batch) => (
                <tr key={batch.批次编号}>
                  <td>{batch.批次编号}</td>
                  <td>
                    <span className={`badge ${batch.批次状态 === '进行中' ? 'badge-open' : 'badge-closed'}`}>
                      {batch.批次状态}
                    </span>
                  </td>
                  <td>{batch.告警级别}</td>
                  <td>{batch.异常数量}</td>
                  <td>{batch.生成时间}</td>
                  <td>{batch.关闭时间 ?? '—'}</td>
                  <td>{batch.只读 ? '是' : '否'}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="evidence-note">{selectedDetail.说明}</p>
        </div>
      )}

      <footer className="page-foot">
        <span>共 {total} 条质量监控记录</span>
        {notice && <span className="badge badge-synced">{notice}</span>}
        {errorMessage && <span className="error-text">{errorMessage}</span>}
      </footer>
    </section>
  )
}
