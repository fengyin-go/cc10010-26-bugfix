# 数据湖治理配置中心

离线版数据湖治理配置工具，涵盖多源接入通道、分层表结构设计、湖区分区策略、流批转换编排、元数据编目检索与资源计量管理，所有配置持久化到浏览器本地存储。

这是一个**纯前端**管理平台：React + Vite + TypeScript，仓库里没有后端服务。业务数据由
`frontend/src/data/` 下的本地数据层提供：首次打开用示例数据播种，之后的登记、筛选与状态流转
结果都持久化在浏览器 `localStorage` 里，刷新或重开浏览器都还在。dev server 已关掉自动打开页面，
启动后按终端打印的地址手工打开。

## 目录结构

```text
.
├── frontend/                 React + Vite + TypeScript 前端（唯一运行单元）
│   ├── src/views/            每个业务模块一个页面
│   ├── src/api/local-service.ts   本地数据服务：列表、筛选、动作流转、导出
│   ├── src/data/             模块元数据 / 示例数据 / localStorage 持久化
│   ├── src/stores/           会话与筛选状态
│   └── vite.config.ts        dev server 配置（open: false，无 /api 代理）
├── .gitignore
└── docker-compose.yml
```

## 启动

```bash
cd frontend
npm install
npm run dev
```

前端默认监听 `http://127.0.0.1:5173/`，dev server 不会自动打开浏览器，需要自己访问。

生产构建：

```bash
cd frontend
npm run build
```

## 业务模块

| 模块 | 目录 | 业务对象 | 主要字段 |
| --- | --- | --- | --- |
| 数据编目 | `catalog` | 数据目录 | 编目编号、数据集名称、存储路径 |
| 多源接入 | `ingest` | 接入通道 | 通道编号、源端类型、连接参数 |
| 原始层管理 | `bronze` | 原始表 | 表编号、来源通道、目标路径 |
| 清洗层管理 | `silver` | 清洗表 | 表编号、上游原始表、清洗脚本 |
| 聚合层管理 | `gold` | 聚合视图 | 视图编号、上游清洗表、聚合维度 |
| 湖区分区 | `lakezone` | 分区方案 | 方案编号、目标表名、分区字段 |
| 流式处理 | `stream` | 流处理作业 | 作业编号、输入Topic、处理逻辑 |
| 批量转换 | `batch` | 批处理任务 | 任务编号、输入路径、处理脚本 |
| 版本快照 | `snapshot` | 快照记录 | 快照编号、目标表名、快照时间 |
| 湖仓治理 | `govern` | 治理规则 | 规则编号、治理对象、治理类型 |
| 元数据中心 | `meta` | 元数据条目 | 条目编号、对象类型、对象名称 |
| 血缘图谱 | `lineage` | 血缘节点 | 节点编号、节点类型、节点名称 |
| 质量监控 | `quality` | 质量指标 | 指标编号、监控对象、指标类型 |
| 编排调度 | `schedule` | 编排计划 | 计划编号、任务列表、依赖图定义 |
| 历史回填 | `backfill` | 回填作业 | 作业编号、目标表名、回填起始 |
| 数据检索 | `search` | 检索索引 | 索引编号、索引名称、覆盖表名 |
| 资源计量 | `resource` | 计量记录 | 记录编号、计算引擎、作业名称 |
| 操作审计 | `audit` | 审计日志 | 日志编号、操作类型、操作对象 |

## 约定

- 每个模块的页面在 `frontend/src/views/<模块>/index.vue`，页面只负责渲染，读写统一走
  `frontend/src/api/local-service.ts`。
- 字段、状态、动作与流转目标集中在 `frontend/src/data/modules.ts`；示例数据在
  `frontend/src/data/seed.ts`。
- 状态流转只允许在 `local-service.ts` 里改，页面组件不做业务判断。
- 想回到初始数据：清掉浏览器里 `lake-govern-config:entries` 这一项，或调用 `resetModule(模块)`。

## 质量监控停用链路

质量监控（监控对象）→ 检测批次记录 → 数据检索索引状态是一条显式调用链，领域逻辑集中在
`frontend/src/data/quality-domain.ts`（持久化与类型）与 `frontend/src/api/quality-service.ts`
（状态流转），通用 CRUD 层不直接改质量指标状态：

- **停用即闭环**：停用后不再新建检测批次，进行中批次全部关闭并转只读；下游检索索引只读取当前
  有效指标，停用指标的有效告警恒为 0。
- **历史告警只读**：已关闭批次与旧阈值/告警级别按原口径保留为只读证据，累计结果出现偏差时，
  告警详情逐批指明来源批次（新口径有效异常 vs 旧口径历史累计）。
- **并发与断点**：指标行带版本号，两个标签页同时停用只接受首个结果，后到的按版本冲突拒绝；
  索引写回状态记录在停用结论里，写回中断后从仍为「待同步」的索引继续，历史告警不会被清零。
- **单向状态机**：质量指标只能按 草稿→待校验→已启用→已停用 推进，通用层也禁止任何模块倒序恢复。
- 领域专属数据存在独立 localStorage 键（`lake-govern-config:quality-batches`、
  `lake-govern-config:quality-deactivations`），重置质量模块时一并清空。

## 测试

```bash
cd frontend
npm test      # 用 Vite 自带 esbuild 打包领域测试后在 Node 运行，无需额外测试框架
```

领域：数据工程
子方向：数仓与数据湖
