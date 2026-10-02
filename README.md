# 考古发掘现场记录与出土物整理工作台

面向探方发掘进度、地层堆积编录、遗迹单位登记、出土物整理与检测送样的一体化田野考古记录工作台。

这是一个**纯前端**管理平台：Vue 3 + Vite + TypeScript，仓库里没有后端服务。业务数据由
`frontend/src/data/` 下的本地数据层提供：首次打开用示例数据播种，之后的登记、筛选与状态流转
结果都持久化在浏览器 `localStorage` 里，刷新或重开浏览器都还在。dev server 已关掉自动打开页面，
启动后按终端打印的地址手工打开。

## 目录结构

```text
.
├── frontend/                 Vue 3 + Vite + TypeScript 前端（唯一运行单元）
│   ├── src/views/            每个业务模块一个页面
│   ├── src/api/local-service.ts   本地数据服务：列表、筛选、动作流转、导出
│   ├── src/data/             模块元数据 / 示例数据 / localStorage 持久化
│   ├── src/stores/           会话与筛选状态
│   └── vite.config.ts        dev server 配置（open: false，无 /api 代理）
├── scripts/                  定稿闸门、回滚、干净克隆演练脚本
├── release-records/          闸门检查留档（latest.md 随仓库走）
├── .github/workflows/        CI 上的定稿闸门
├── Makefile                  gate / rollback / clean-clone 等入口
├── .gitignore
└── docker-compose.yml        frontend 为生产构建（nginx 托管）；--profile dev 起开发服务器
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

## 定稿闸门（发布前流水线）

发掘简报「确认定稿」之前必须先过闸门：**依赖安装 → 依赖校验 → 类型检查 → 生产构建**，
任何一段失败都会挡下定稿，并把出错的文件与缺少的依赖列出来。所有路径都按脚本位置推导，
不写死工作目录。

```bash
make gate          # 顺序跑完四个阶段（= node scripts/release-gate.mjs）
make gate-deps     # 只跑到依赖校验
make gate-typecheck
make gate-build
```

闸门特性：

- **断点续跑**：每个阶段按输入内容（package.json、lockfile、源码、Node 版本）计算指纹并落标记；
  构建中断后再跑，只补没跑完的阶段，已经通过且输入未变的不再重跑。`make gate-reset` 可清空状态。
- **干净克隆可复现**：`make clean-clone` 会在 `mktemp -d` 临时目录里克隆仓库、`npm ci`
  装依赖、跑闸门到构建产物，验证从零开始能跑通；安装严格按 `frontend/package-lock.json`。
- **构建幂等**：build 阶段会清空 `dist` 连构建两次并比对文件清单与哈希，
  缓存清理后反复装载不会产生重复或漂移产物。
- **留档**：每次运行写 `release-records/latest.md`（人读）和 `.release-gate/runs/*.json`
  （全量历史）；CI 会把留档与 dist 作为 artifact 上传。
- **回滚**：通过闸门时会快照本次产物，`make rollback` 可把 `frontend/dist`
  恢复为最近一次通过的构建，并清空闸门状态强制下次完整复检；
  代码层回退用 `git revert <定稿提交>`。

应用内的定稿门禁（`src/data/release-gate.ts`）在简报页点「确认定稿」时触发，
校验简报编号、涉及探方（须在探方登记中存在）、校核结论、校核意见数与数据依赖；
不通过就挡下定稿，通过则把简报置为「已定稿」并在「探方验收」模块生成一条
`简报定稿验收` 待办（同一简报重复定稿幂等，不会重复生成）。每次检查结果都留档，
简报页可点「导出闸门检查留档」下载（localStorage 键
`archaeology-field:gate-reports`）。

CI（`.github/workflows/release-gate.yml`）在推 main 或发 PR 时执行同样的闸门与干净克隆演练，
失败即挡下合并/部署。

## 业务模块

| 模块 | 目录 | 业务对象 | 主要字段 |
| --- | --- | --- | --- |
| 探方登记 | `trench` | 探方 | 探方编号、所属发掘区、布方面积 |
| 地层堆积 | `stratum` | 地层堆积 | 层位编号、所属探方、土质 |
| 遗迹单位 | `feature` | 遗迹单位 | 单位编号、遗迹类型、所属探方 |
| 出土物登记 | `find` | 出土物 | 器物编号、出土探方、出土层位 |
| 陶片拼对 | `sherd` | 拼对记录 | 拼对编号、所属单位、陶系 |
| 骨骼标本 | `bone` | 骨骼标本 | 标本编号、出土单位、种属 |
| 浮选样品 | `flotation` | 浮选样品 | 样品编号、采样单位、样品重量 |
| 测年送检 | `dating` | 测年送检单 | 送检编号、样品来源、承接实验室 |
| 测绘控制点 | `survey` | 测绘控制点 | 点位编号、控制等级、北坐标 |
| 影像资料 | `photo` | 影像资料 | 影像编号、拍摄对象、拍摄方向 |
| 发掘日记 | `diary` | 发掘日记 | 日记编号、记录日期、记录人 |
| 用工派工 | `labor` | 出工记录 | 派工编号、作业区域、用工类别 |
| 工具领用 | `tool` | 工具领用单 | 领用单号、领用人、工具名称 |
| 安全巡查 | `safety` | 安全巡查记录 | 巡查编号、巡查区域、巡查类别 |
| 样品封装 | `packing` | 封装记录 | 封装编号、所属单位、封装材料 |
| 标本修复 | `conserve` | 修复单 | 修复单号、修复对象、病害描述 |
| 简报校核 | `briefing` | 发掘简报 | 简报编号、涉及探方、编写人 |
| 探方验收 | `acceptance` | 探方验收单 | 验收单号、验收探方、验收类别 |

## 约定

- 每个模块的页面在 `frontend/src/views/<模块>/index.vue`，页面只负责渲染，读写统一走
  `frontend/src/api/local-service.ts`。
- 字段、状态、动作与流转目标集中在 `frontend/src/data/modules.ts`；示例数据在
  `frontend/src/data/seed.ts`。
- 状态流转只允许在 `local-service.ts` 里改，页面组件不做业务判断。
- 想回到初始数据：清掉浏览器里 `archaeology-field:entries` 这一项，或调用 `resetModule(模块)`。
