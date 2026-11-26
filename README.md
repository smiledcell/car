v# Car 赛车游戏 · Week 05 / Week 07 Group Project

## 游戏目的

这是一个在浏览器中运行的 3D 赛车游戏。玩家选择赛道、难度和比赛长度，使用键盘驾驶，完成有效圈数并争取更好的比赛排名或圈速；也可以先参加排位，再进入正赛。Week 07 沿用本项目，重点是可复现发布、文档协作与部署验证，不是重新制作游戏。

## 在线游玩与发布状态

- **共享可玩网址：待发布负责人在真实部署成功后填写。** 当前没有在本文中确认任何线上地址，不能将本地地址当作公共网站。
- 计划托管：**GitHub Pages**。当前游戏为静态 HTML/JavaScript/WebGL，不需要运行后端；无需因 Pages 改写游戏。
- 默认首页：[index.html](<index.html>) 自动进入 [car.html](<car.html>)，保留查询参数和锚点；采用相对路径，以兼容仓库子路径。
- 全组共用同一可玩站点，不部署成员各自的 fork。
- 公共仓库链接：[smiledcell/car](https://github.com/smiledcell/car)。

> 发布前必须补齐真实网址和仓库链接。下面的部署步骤是操作说明，不表示工作流或线上部署已经完成。

## 项目结构与启动原理

本文件夹是小组作业，不是 APEX 原版仓库。`third-party/apex-formula-2026/` 仅存放使用到的上游模块、库、素材和许可副本，不包含完整项目或 Git 历史。完整原版项目留在本文件夹之外。

这是对 [APEX FORMULA 2026](https://github.com/ahacker-1/apex-formula-2026) 原项目的本地集成与改编。实际游戏入口是 [car.html](<car.html>)，不是原项目菜单页或另一个演示页面。页面加载经典脚本 [apex-runtime.js](<js/apex-runtime.js>)：它将原项目模块、Three.js 和 base64 GLB 打包为 IIFE，提供 `THREE`、`APEX_VISUALS` 和 `APEX_READY`；模型通过 `GLTFLoader.parse` 从内嵌字节解析，不发起模型 fetch。`APEX_READY` 完成后才加载经典脚本 [car-game.js](<js/car-game.js>)。比赛、排位、AI、维修区、天气与轮胎逻辑继续由本项目的独立核心脚本提供。

## 运行：支持直接双击

**无需 `npm install`，也无需 HTTP 服务即可游玩。** 保持项目目录完整，在支持 WebGL 的现代浏览器中双击根目录 [index.html](<index.html>)（自动进入 [car.html](<car.html>)），或构建后双击 [发布版首页](<dist/index.html>)，均可通过 `file://` 打开。不要只复制 HTML；需要保留同级脚本和发布目录中的完整相对路径。建议使用带实体键盘的桌面浏览器，并开启可用的硬件加速。

也可选用 HTTP。在项目根目录运行：

```bash
python3 -m http.server 8765
```

Windows 也可使用 `py -m http.server 8765`。然后打开 <http://localhost:8765/car.html>。

保持 [apex-formula-2026](<third-party/apex-formula-2026/>) 下的模块、库及素材和本地脚本、许可文件完整。出现加载错误时检查浏览器 Console、脚本路径和 WebGL 支持；HTTP 模式还可检查 Network 中的 404。当前页面不依赖浏览器 import map 或运行时 ES module 加载。

## 当前集成内容

- 实际调用原项目 [trackBuilder.js](<third-party/apex-formula-2026/js/trackBuilder.js>) 的 `buildCircuit` 构建赛道路面、护墙、看台、PIT 车库、地形和远景，沿用原版赛道主题；不是仅借用设计思路的简化替代场景。
- 实际调用原项目 [car.js](<third-party/apex-formula-2026/js/car.js>) 的 `buildCarMesh`；[f1car-2026.glb](<third-party/apex-formula-2026/assets/f1car-2026.glb>) 已内嵌在运行时包中，启动时先解析模型并完成预加载，再启动游戏，不需要模型 URL 请求。原车构建器仍保留程序化模型能力。
- HUD 小地图按原赛道采样绘制路径，标出起终点、PIT、玩家及 AI 位置。
- 可选择 2026 赛历的 24 条赛道，提供键盘驾驶、三档 AI 难度、圈数、最佳圈、实时排名、结果页和可选本地最佳圈保存。
- 正赛可选择 5 圈或分段/完整距离；排位采用 22 名车手的 Q1/Q2/Q3 淘汰流程，最终生成正赛发车表。AI 排位时间是确定性模拟成绩，不是实际驾驶成绩。
- Soft / Medium / Hard / Intermediate / Wet 轮胎、磨损、温度、干湿抓地力、水漂风险、动态天气及雨/喷雾效果；ERS 能量与超车。
- **维修区驾驶是本地适配，不是宣称原版已有完整可驾驶维修区。** 保留原版 `buildCircuit` 的 PIT 车库及维修墙，根据原车库位置推导入口、通道、停站框和出口，并接入现有进站核心：自动限速、超速处罚、停车换胎和 AI 基础进站。

### 操作

| 输入 | 功能 |
| --- | --- |
| 方向键 / WASD | 油门、制动/倒车、转向 |
| Space | ERS 超车 |
| R | 重置当前驾驶/排位状态 |
| P | 请求进站，驶入维修区后选择轮胎 |
| L | 手动限速开关；维修区另有自动限速 |

换胎需要在停站框内低速停稳并选择轮胎，服务持续 3 秒；移动或离开会取消服务。当前维修区采用适配几何和简化碰撞，不代表真实赛道的正式维修区布局。

## 源码打包、测试与发布

已附带可直接运行的 [apex-runtime.js](<js/apex-runtime.js>) 及其 [许可注释文件](<js/apex-runtime.js.LEGAL.txt>)。仅在修改 [apex-entry.js](<js/apex-entry.js>)、上游视觉模块或模型后，才需要从项目根目录重新打包（需要 Node.js/npm，首次调用可能需要联网获取 esbuild；无需先执行 `npm install`）：

```powershell
npm.cmd exec --yes --package=esbuild -- esbuild js/apex-entry.js --bundle --format=iife --platform=browser --target=es2020 --alias:three=./third-party/apex-formula-2026/lib/three.module.js --loader:.glb=base64 --outfile=js/apex-runtime.js --legal-comments=linked
```

`--loader:.glb=base64` 将模型作为构建输入嵌入包中；它不是 JavaScript 模块，不能将该导入当作浏览器模块图继续解析。`--legal-comments=linked` 同时生成需要随包保留的许可注释文件。

在项目根目录运行无第三方依赖的静态/数据及比赛核心测试：

```bash
node scripts/test.cjs
```

测试将页面内联脚本和本地外部脚本（包括经典运行时与实际游戏脚本）作为经典 JavaScript 编译，确认无 import map/module 启动桥接、运行时就绪后加载游戏、源码入口与本地构建输入、内嵌 GLB 内容及解析路径；仅使用临时 `.mjs` 对源码入口检查 ESM 语法，不把 GLB 当作 JS 模块遍历。随后执行比赛、排位、维修区和天气/轮胎核心测试。这些检查不执行实际浏览器启动，也不验证真实 WebGL、模型最终显示、键盘事件或渲染画面；`file://` 和 HTTP 的浏览器验收须另行执行。

生成发布目录：

```bash
node scripts/build.cjs
```

发布构建仅复制已生成的运行时及依赖，不重新运行 esbuild，也不改写源页面或源脚本。输出 [dist/index.html](<dist/index.html>) 和 [dist/car.html](<dist/car.html>)，并保持以下依赖的相对路径：

- 本地比赛核心、实际游戏脚本、源码入口、经典运行时及其许可注释（输出的 `js/` 目录）；
- 可选浏览器自检脚本（输出的 `tests/game-smoke.js`）；
- 原项目的 `third-party/apex-formula-2026/js/`、`lib/`、`assets/`；
- 原项目的 `LICENSE`、`NOTICE`、`THIRD_PARTY_NOTICES.md` 和 `LICENSES/`。

**交付完整的发布目录，而不是只交付 HTML。保持目录完整即可直接双击 [dist/car.html](<dist/car.html>)。** 也可选择通过 HTTP 发布：

```bash
python3 -m http.server 8765 --directory dist
```

打开 <http://localhost:8765/car.html>。可在页面 URL 上增加 `?selftest=1` 请求浏览器内集成自检；这些检查的结果须以本次实际浏览器执行为准，不应由静态测试推断通过。

## GitHub Pages 发布说明

### 本地准备

1. 使用本作业目录作为团队公共仓库根目录；不要上传上一级浏览器配置、其他原版项目或私人报告。
2. 保留完整源码、模型与许可文件；排除依赖、缓存和凭据。现有 [.gitignore](<.gitignore>) 忽略发布目录 `dist/`，适合由 Actions 生成产物。
3. 准备支持 `fs.cpSync` 的 Node.js（建议 Node.js 22）并执行：

```bash
node scripts/test.cjs
node scripts/build.cjs
node scripts/check-release.cjs
```

4. 用前述 HTTP 命令预览发布目录，访问 <http://localhost:8765/>，检查首页跳转、资源和基本操作。这里只是本地预览，不是作业要求的公共地址。

### 已实现的 Actions 发布流程

配置见 [pages.yml](<.github/workflows/pages.yml>)，无需再手写工作流。将本目录作为仓库根目录上传；发布负责人在团队仓库 Settings → Pages 中选择 **GitHub Actions**。

- **推送到 `main`：**自动测试、构建、检查发布包并部署共享站点。
- **向 `main` 提交 PR：**自动运行测试、构建与发布包检查，不部署 PR 版本。
- **手动运行：**可在 Actions 中运行工作流；只有选择 `main` 才会执行部署。
- **构建步骤：**checkout → Node.js 22 → `node scripts/test.cjs` → `node scripts/build.cjs` → `node scripts/check-release.cjs` → 上传完整 Pages artifact。
- **部署步骤：**构建成功后配置 Pages，使用 `pages: write` 和 `id-token: write` 部署至 `github-pages` 环境；环境记录输出实际网站 URL。
- **源码关联：**工作流摘要记录该次构建的源码 SHA；应将 Actions run 与对应提交一起核对。PR 构建可能使用 GitHub 生成的合并测试提交，不应冒充已部署的团队 `main`。

上线后，将真实网址补到本文顶部；各成员的文档 PR 经他人审核、回应并合并后，发布最终版本。在私人报告保存最终团队 `main` commit 和匹配部署记录，不把本文自身最终 hash 写进本文。如果 Pages 设置、权限或环境审批阻止部署，应根据 Actions 日志处理，不将失败描述成成功。

本项目无需 `npm install` 即可执行现有测试和复制构建。修改视觉模块或模型后，仍须先按上文重新打包运行时。Pages 不运行后端；本项目目前无需其他托管平台。

## CI/CD exploration — 第一次真实部署尝试

2026-11-26 核查了 [Actions run #1](https://github.com/smiledcell/car/actions/runs/45730701731)（attempt 1）。该次部署尝试没有成功上线，不能把构建成功写成部署成功。

| 记录项 | 实际观察 |
| --- | --- |
| 源码版本 | [70d2b11](https://github.com/smiledcell/car/commit/70d2b11750b90b5ab300a0b2db06f5844f6aec94)，分支 `main`；这是被检查的较早源码，不是 README 自身的最终 hash |
| 触发与时间 | 首次推送到 `main` 触发 `push` 事件；北京时间 2026-11-26 08:43:00 开始，08:43:18 结束，整体结果 `failure` |
| 检查 / 构建 | [Test and build static site](https://github.com/smiledcell/car/actions/runs/45730701731/job/139611685061) 成功；任务步骤记录确认 checkout、Node.js 设置、已有静态/核心测试、完整发布构建、首页/脚本/许可校验、源码摘要与产物上传均为 `success` |
| 发布文件 / 产物 | 工作流将完整 `dist/` 上传为 `github-pages` artifact，ID `15077205294`，API 记录压缩大小 31,407,611 字节，关联同一源码 SHA；内容按构建清单包含默认首页、游戏入口、脚本、模型和许可。已核查上传步骤与产物元数据，没有下载解包逐文件复查该远程 artifact |
| 部署结果 / 阻碍 | [Deploy shared game](https://github.com/smiledcell/car/actions/runs/45730701731/job/139611756174) 在 `Configure Pages` 失败；`Deploy Pages artifact` 被跳过，所以本次没有发布成功的站点 |
| 实际错误 | 错误注释为 `HttpError: Not Found`，并要求确认仓库已启用 Pages、来源配置为 GitHub Actions。这支持优先检查 Pages 设置；仅凭该错误不能断言所有权限与设置的当前状态 |
| 实际运行的一项检查 | `Validate homepage, scripts and license files` 远程步骤成功；对应 [check-release.cjs](<scripts/check-release.cjs>) 验证首页跳转和参数保留、源码副本一致及必要脚本/模型/许可文件存在 |
| 一项有用的缺失检查 | CD异常已经通过设置权限修复 |
| 全员检查与确认 | 确认 |

证据来源：[run 元数据](https://api.github.com/repos/smiledcell/car/actions/runs/45730701731)、[任务与步骤结果](https://api.github.com/repos/smiledcell/car/actions/runs/45730701731/jobs)、[部署错误注释](https://api.github.com/repos/smiledcell/car/check-runs/139611756174/annotations)、[产物元数据](https://api.github.com/repos/smiledcell/car/actions/runs/45730701731/artifacts)。本次核查基于公开 API 的实际执行记录，未取得完整原始文本日志，不声称已逐行阅读完整日志。artifact 有保留期限，元数据不能替代永久发布结果。

CI 自动构建/检查变更；本作业中的 CD 自动发布接受的版本。本次记录显示 **CI 构建成功，但 CD 在 Pages 配置阶段失败**。修复后仍应查看新的真实运行和网站结果；最终报告另存最终团队 commit 与匹配部署记录。本节保留首次尝试作为历史观察，通过文档 PR 接受同伴审查。

## Contributors

以下使用小组提供的姓名署名，不包含学号。角色与贡献依据小组确认、PR 记录和全员试玩反馈整理；学习总结中的关注方向不作为已完成文档编辑、审核或同步操作的证据。

| 公开姓名 / GitHub 昵称 | 实际工作与角色 | 文档 PR / 贡献证据 | 本人确认 |
| --- | --- | --- | --- |
| 刘易 | 发布负责人 / 发布协调；参与共享网站试玩。 | 小组指定的发布负责人；试玩结果由小组汇总反馈。PR #1 不归属于本人。 | 已由小组反馈参与试玩；角色与贡献条目仍需本人核对。 |
| 杨梓淏 / `ptr0812` | 组员 / CI/CD 文档贡献者；整理真实 Actions 运行的测试、构建、部署阻碍及证据；参与共享网站试玩。 | [PR #1](https://github.com/smiledcell/car/pull/1)，分支 `docs/cicd-exploration`，已合并。 | PR 归属已由小组更正确认；条目仍需本人核对。 |
| 黄添荣 | 组员 / 共享网站试玩参与者。 | 小组反馈全员试玩，未发现问题；尚未提供个人文档 PR 或具体审核记录。 | 已由小组反馈参与试玩；条目仍需本人核对。 |
| 官蔚楠 | 组员 / 共享网站试玩参与者。 | 小组反馈全员试玩，未发现问题；尚未提供个人文档 PR、具体审核或同步记录。 | 已由小组反馈参与试玩；条目仍需本人核对。 |
| 郭汉鑫 | 组员 / 共享网站试玩参与者。 | 小组反馈全员试玩，未发现问题；尚未提供个人文档 PR 或具体审核记录。 | 已由小组反馈参与试玩；条目仍需本人核对。 |

发布负责人不等于唯一作者；上游代码、库及素材的作者身份与许可仍应保留。本表不替代每位成员的个人 PR、同伴审核、回应及最终同步证据，也不把小组转述的试玩反馈当作所有贡献条目的本人确认。

## AI assistance disclosure

本次 Week 07 准备使用 AI 编码助手（DeepSeek Harness 会话）辅助检查本地项目的静态部署适用性、添加默认首页及构建入口、实现 Pages Actions 工作流与发布校验脚本、实际执行已有测试/构建/发布校验，并整理 README 的运行/发布说明、配置事实与当前阻碍。此说明不推定 Week 05 的全部 AI 使用情况；成员如有其他实质 AI 协助，应在相关条目或 PR 中补充实际情况。

AI 未替成员执行 GitHub 登录、确认个人贡献或进行同伴审核；本次还辅助核查了首次真实 Actions 运行的公开任务结果、错误注释及产物元数据，并整理本节观察。成员须自行查看证据并确认，不将 AI 核查等同于全员确认；尚未确认游戏成功上线。个人学习总结由每位成员自行撰写，不由 AI 生成、翻译、改写或润色；本公共 README 不收录私人学习总结及学号。

## 已知限制与最终验收

- 需要支持 WebGL 的现代浏览器；模型、阴影与赛道渲染对设备性能有要求，没有据此保证所有手机或低性能设备可用。
- 当前说明以键盘操作为主，不能据此承诺完整触屏支持。
- 最佳圈存储在当前浏览器的 `localStorage`，不跨设备同步；清除站点数据可能丢失记录。
- 排位 AI 成绩为确定性模拟；比赛物理、碰撞、赛道与维修区布局均有游戏化简化。
- 本次本地执行已有测试通过：91 项静态/数据检查、11 项比赛核心、9 项排位、8 项维修区、8 项天气测试。这不是线上 CI 结果，也不证明浏览器画面或游戏交互通过。
- 现有构建只复制预打包运行时，修改其源码输入后必须另行重新打包；发布包保留较多上游文件，有体积优化空间，不能随意删去必要素材和许可。
- 当前尚未确认线上部署和全员最终试玩；具体线上问题应在真实检查后记录，不能写“无问题”代替未检查。

最终部署后，每位成员应在未登录 GitHub 的浏览器环境打开同一网站，检查开始/游玩、控制、进度、重开、模型及其他素材、声音/静音。声音功能须实际核查；未实现则如实写不适用，不能因包含 Three.js 音频类就宣称有音效。共享私人记录保存实际检查结果、确认和未解决问题；若修复产生新 commit，更新版本与匹配部署证据并复查受影响部分。


