import './setup-globals'

import { resetModule, runAction, listEntries, loadOverview } from '@/api/local-service'
import {
  alarmDetail,
  applyQualityAction,
  deactivateMetric,
  effectiveAlarmCount,
  historicalAlarmCount,
  listIndexQualityStatus,
  qualityStats,
  runQualityCheck,
  writeIndexStatus,
} from '@/api/quality-service'
import { getConclusion, saveConclusion, listQualityBatches } from '@/data/quality-domain'
import { listRows } from '@/data/local-store'
import type { EntryRow } from '@/data/types'

let passed = 0
let failed = 0

function check(name: string, cond: boolean, extra = ''): void {
  if (cond) {
    passed += 1
    console.log(`  ✓ ${name}`)
  } else {
    failed += 1
    console.error(`  ✗ ${name} ${extra}`)
  }
}

function qualityRow(code: string): EntryRow {
  const row = listRows('quality').find((item) => String(item.指标编号) === code)
  if (!row) {
    throw new Error(`缺少指标 ${code}`)
  }
  return row
}

function searchRow(code: string): EntryRow {
  const row = listRows('search').find((item) => String(item.索引编号) === code)
  if (!row) {
    throw new Error(`缺少索引 ${code}`)
  }
  return row
}

// 回到示例数据，保证每个用例起点一致。
resetModule('quality')

const metricId = Number(qualityRow('QUAL-0003').id)

console.log('一、停用前基线：已关闭批次不计入当前有效告警')
check(
  '启用指标的有效告警只统计进行中批次（2），已关闭批次的 5 不算',
  effectiveAlarmCount('QUAL-0003', '已启用') === 2,
)
check('旧口径累计包含已关闭批次（5+2=7）', historicalAlarmCount('QUAL-0003') === 7)
const beforeStats = qualityStats(listEntries('quality').items)
check('列表统计的当前有效告警为 2', beforeStats.effectiveAlarms === 2)
const beforeIndex = listIndexQualityStatus(listRows('search')).find((item) => item.row.索引编号 === 'SEAR-0002')
check('下游索引在指标启用时读到有效告警 2', beforeIndex?.effectiveAlarms === 2)

console.log('二、停用后不再新建批次，待校验/停用指标的校验请求被拒绝')
const checkOnPending = runQualityCheck(qualityRow('QUAL-0002'))
check('待校验指标不会继续产生检测报错与批次', checkOnPending.ok === false && checkOnPending.message.includes('启用后'))
const batchCountBefore = listQualityBatches().length
const enabledRow = qualityRow('QUAL-0003')
const created = runQualityCheck(enabledRow)
check('启用指标可以产生新检测批次', created.ok && listQualityBatches().length === batchCountBefore + 1)

console.log('三、两个标签页同时停用：只接受首个结果（版本号乐观锁）')
const firstStop = deactivateMetric(metricId, 0)
check('首个停用请求成功，提示含停用时间', firstStop.ok && /\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(firstStop.message))
const stopTime = getConclusion('QUAL-0003')?.停用时间 ?? ''
check('停用结论记录了停用时间', stopTime.length > 0)
const staleStop = deactivateMetric(metricId, 0)
check('另一标签页拿旧版本号停用被拒绝', staleStop.ok === false && staleStop.message.includes('另一个标签页'))
const repeatStop = deactivateMetric(metricId, 1)
check('重复停用被拒绝且提示原停用时间', repeatStop.ok === false && repeatStop.message.includes(stopTime))

console.log('四、停用链路：批次关闭转只读，历史告警不清零')
const batches = listQualityBatches().filter((b) => b.指标编号 === 'QUAL-0003')
check('停用后没有进行中批次', batches.every((b) => b.批次状态 === '已关闭'))
check('全部批次转只读', batches.every((b) => b.只读 === true))
check('历史异常数量原样保留（5+2+0=7），未被清零', batches.reduce((s, b) => s + b.异常数量, 0) === 7)
const checkOnStopped = runQualityCheck(qualityRow('QUAL-0003'))
check('停用后不再新建批次，异常提示写明停用时间', checkOnStopped.ok === false && checkOnStopped.message.includes(stopTime))

console.log('五、下游索引只读取当前有效指标，跨模块清单随停用结论更新')
check('停用指标有效告警恒为 0', effectiveAlarmCount('QUAL-0003', '已停用') === 0)
const afterIndex2 = listIndexQualityStatus(listRows('search')).find((item) => item.row.索引编号 === 'SEAR-0002')
const afterIndex3 = listIndexQualityStatus(listRows('search')).find((item) => item.row.索引编号 === 'SEAR-0003')
check('关联索引当前有效告警归零', afterIndex2?.effectiveAlarms === 0 && afterIndex3?.effectiveAlarms === 0)
check('两个索引写回状态均为已同步', afterIndex2?.writebackState === '已同步' && afterIndex3?.writebackState === '已同步')
const idx2 = searchRow('SEAR-0002')
check('索引残留旧告警没有被清零（保留证据基线 3）', Number(idx2.历史告警数) === 3)
check('索引记录指标已停用与停用结论', String(idx2.指标状态) === '已停用' && String(idx2.停用结论).includes(stopTime))
check('索引行不再带异常标记', idx2.abnormal === false)

console.log('六、写回中断：从尚未更新的索引继续，已同步的不重复处理')
const conclusion = getConclusion('QUAL-0003')!
const syncedBefore = conclusion.索引写回.find((i) => i.索引编号 === 'SEAR-0002')?.同步时间
saveConclusion({
  ...conclusion,
  索引写回: [...conclusion.索引写回, { 索引编号: 'SEAR-9999', 状态: '待同步', 同步时间: null }],
})
const partial = writeIndexStatus('QUAL-0003')
check('不存在的索引写回失败，其余索引不受影响', partial.some((r) => r.code === 'SEAR-9999' && !r.ok))
const conclusion2 = getConclusion('QUAL-0003')!
check('已同步索引没有被重复处理（同步时间不变）', conclusion2.索引写回.find((i) => i.索引编号 === 'SEAR-0002')?.同步时间 === syncedBefore)
check('中断期间历史告警仍保留', Number(searchRow('SEAR-0002').历史告警数) === 3)
conclusion2.索引写回 = conclusion2.索引写回.filter((i) => i.索引编号 !== 'SEAR-9999')
saveConclusion(conclusion2)
const resumed = writeIndexStatus('QUAL-0003')
check('续跑后全部索引写回成功', resumed.length === 2 && resumed.every((r) => r.ok))

console.log('七、告警详情：新老口径冲突时偏差可追溯到来源批次')
const detail = alarmDetail(qualityRow('QUAL-0003'))
check('详情当前有效异常为新口径 0', detail.当前有效异常 === 0)
check('详情历史累计异常为旧口径 7', detail.历史累计异常 === 7)
check('口径偏差=7 且来源批次异常合计对得上', detail.口径偏差 === 7 && detail.来源批次.reduce((s, b) => s + b.异常数量, 0) === 7)
check('来源批次逐批列出且已关闭批次标注不计入', detail.来源批次.every((b) => b.批次状态 === '已关闭'))
check('异常说明写明停用时间', detail.说明.includes(stopTime))
const stopped = qualityRow('QUAL-0003')
check('旧阈值结论按原口径保留（告警级别、阈值范围字段未被改写）', String(stopped.告警级别) === '质量监控样例3' && String(stopped.阈值范围) === '质量监控样例3')
check('停用结论批次快照保留原告警级别', getConclusion('QUAL-0003')?.批次快照.every((s) => s.告警级别.length > 0) === true)

console.log('八、状态只能按启用到停用的顺序推进，不能倒序恢复')
const backward = applyQualityAction(metricId, '启用监控', qualityRow('QUAL-0003'))
check('已停用指标不能倒序回启用', backward.ok === false && backward.message.includes('单向推进'))
const skipFlow = applyQualityAction(Number(qualityRow('QUAL-0001').id), '启用监控', qualityRow('QUAL-0001'))
check('草稿指标不能跳过待校验直接启用', skipFlow.ok === false)
const genericBackward = runAction('bronze', Number(listRows('bronze').find((r) => r.status === '已启用')!.id), '提交校验')
check('通用流转同样禁止倒序（已启用→待校验被拒）', genericBackward.ok === false && genericBackward.message.includes('单向推进'))

console.log('九、列表与概览不再把停用指标显示成旧告警')
const deactivatedRow = qualityRow('QUAL-0003')
check('停用指标行 abnormal 已撤销', deactivatedRow.abnormal === false)
check('停用指标行带停用时间与版本号', String(deactivatedRow.停用时间) === stopTime && Number(deactivatedRow.version) === 1)
const overviewQuality = loadOverview().modules.find((m) => m.name === '质量监控')
check('概览异常量不含停用指标（只剩待校验种子行 1 条）', overviewQuality?.abnormal === 1)
const afterStats = qualityStats(listEntries('quality').items)
check('停用后统计：有效告警 0、历史证据 7、停用指标 1', afterStats.effectiveAlarms === 0 && afterStats.historicalAlarms === 7 && afterStats.deactivated === 1)

console.log(`\n结果：${passed} 通过，${failed} 失败`)
if (failed > 0) {
  process.exit(1)
}
