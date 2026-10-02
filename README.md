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
│   ├── src/api/pipeline-status.ts 读取定稿前检查结果（public/pipeline-status.json）
│   ├── src/data/             模块元数据 / 示例数据 / localStorage 持久化
│   ├── src/stores/           会话与筛选状态
│   └── vite.config.ts        dev server 配置（open: false，无 /api 代理）
├── scripts/finalization-pipeline.mjs   定稿前检查流水线（依赖校验 → 类型检查 → 构建）
├── Makefile                  install / dev / build / pipeline / rollback 等入口
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

## 定稿前检查流水线

简报「确认定稿」之前必须先过检查：**依赖校验 → 类型检查 → 构建**，任一阶段失败就挡下定稿。

```bash
make pipeline          # 跑检查（中断后重跑会自动续上没跑完的阶段，已通过的不重跑）
make pipeline-force    # 无视断点状态，全量重跑
make clean             # 清构建缓存与产物（frontend/dist、node_modules/.vite）
make rollback          # 回滚到上一版构建产物
```

- **挡下定稿**：失败时报告列出出错的文件（解析 vue-tsc 输出）和缺失的依赖
  （`npm ls` 校验 + 源码裸导入比对 package.json）。简报页读取
  `frontend/public/pipeline-status.json`，未通过时「确认定稿」直接挡下并亮出明细。
- **回滚策略**：构建前自动把现有 `frontend/dist` 备份到 `.pipeline/rollback/dist`，
  构建失败自动恢复；事后可用 `make rollback` 手动回滚到上一版产物；简报数据侧用
  「退回修改」动作回退。
- **断点续跑**：阶段状态与输入指纹写在 `.pipeline/state.json`（原子写入），构建中断后
  重跑只补没跑完的阶段；`node scripts/finalization-pipeline.mjs clean` 可清掉状态全量重跑。
- **反复装载不产生重复产物**：依赖用 `npm ci`（先清 `node_modules` 再按
  `frontend/package-lock.json` 装），构建由 vite 先清空 `dist` 再产出（`emptyOutDir`）。
- **留档**：每次运行把报告归档到 `pipeline-reports/`（JSON + Markdown，`latest.json`
  指向最近一次）。定稿成功后，结果自动落成一条「待验收」的探方验收单（验收待办），
  并在简报页「定稿留档」里可查。
- **干净克隆验证**：`git clone` 后执行 `make pipeline` 即可从装依赖到构建一次跑通，
  脚本路径全部相对仓库根推导，不写死。

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
- 简报「确认定稿」由定稿前检查流水线闸口把关（见上节），定稿成功才生成验收待办并留档。
- 想回到初始数据：清掉浏览器里 `archaeology-field:entries` 这一项，或调用 `resetModule(模块)`；
  定稿留档存在 `archaeology-field:finalization-archive`，不受模块重置影响。
