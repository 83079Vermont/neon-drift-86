# NEON DRIFT '86 — 独立验证报告（verifier）

**结论：PASS WITH ISSUES**（0 个 FAIL；2 个 WARN；验证期间发现的 2 个实质缺陷已由 engine / gameplay 修复并复验通过）

- 契约测试：**61 项，59 PASS / 0 FAIL / 2 WARN / 0 SKIP**（`tools/contract-test.mjs`，54 s）
- 帧导出：**12 张 gameplay 帧 + 1 张精灵图集，0 张纯色、0 张 mode/stage 不符**（`tools/render-frames.mjs`，102 s）
- 一键复现：`& "C:\Users\wanji\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe" tools\run-all.mjs --full-soak`
- 被验证的 src 版本（每文件 sha256 前 12 位，见 `.verify/frames/manifest.json` → `srcHashes`）：

| core | road | sprites | audio | render | input | game | combined |
|---|---|---|---|---|---|---|---|
| da19aeed1939 | 0cdf2bbb4979 | 1c9859acfd69 | 8d3544371647 | 038fc1787cbb | 7cbf8e0ea7ef | eeabe4d5f9b3 | **8990437474dedd08** |

> 报告内所有帧、所有数字都对应上表版本。**src 一旦再改动，manifest 的 `srcHashes` 会与磁盘不符**，
> `integration.frames-on-disk-are-current` 会立刻变红并提示重跑 `tools/render-frames.mjs`（我在开发过程中正是靠这条绊线发现队友改了 render.js/game.js 并重出全部帧）。

### 验证期间发现并已闭环的问题（详见第 2 节）

| # | 问题 | 级别 | 状态 |
|---|---|---|---|
| 2.1 | `Track.checkpoints` 缺尾部终点线项 → 过起点线不算圈、关卡推进失效 | HIGH | **已修复**（road.js）并复验 |
| 2.2 | CRT pass 整屏压暗，亮度只剩 41%（"subtle" 名不副实） | HIGH（观感/性能） | **已修复**（render.js 重写 chromaPass）并复验 |
| 2.3 | 标题菜单方向键即激活 + 菜单从未绘制 | MEDIUM | **已修复**（game.js）并复验 |
| 2.4 | `ROAD.project()` screen.x/y/w 取整，偏离 §3 原式 | LOW | 保留为 WARN（像素画合理取舍，待 lead 决定是否写入契约） |
| 2.5 | gameover 时 SCORE 归零 | INFO | 属设计（分数按关重置），非缺陷 |
| 2.6 | 帧导出的白盒强制完赛 | INFO | 手段说明；真跑模式 `--real-race` 可选 |
| 2.7 | index.html 含 1 个 inline `<script>` | WARN | 打包时勿重排顺序 |

---

## 0. 方法与前提（为什么不是浏览器）

DSH 沙箱阻断 Chromium 命名管道，本会话无头浏览器/截图**不可用**（Lead 已反复验证）。
因此验证改为：用 `tools/canvas-shim.mjs` 在 Node 里实现一个**够用且严格**的 Canvas2D + 最小 DOM，
再用 `vm.runInThisContext` 按 `index.html` 的固定顺序执行**未经修改的 `src/*.js`**，
把真实绘制结果写成 PNG 供人工审阅。

垫片的关键设计（也是它能当"验证工具"而不是"假实现"的原因）：

| 机制 | 作用 |
|---|---|
| **未知 ctx 成员 → 抛 `CanvasShimError`（带调用栈）** | 渲染层用了未实现 API 时立刻暴露，绝不静默变 undefined |
| 绊线：`fetch`/`XMLHttpRequest`/`WebSocket`/`img.src`/`Math.random()`/`ctx.fillText()`/`shadowBlur>0` | 违反 CONTRACT §0/§4/§6 时记为 violation（本轮为 0） |
| 虚拟时钟统一驱动 `performance.now`/`Date.now`/rAF/`setTimeout`/`Math.random` | 两次运行结果逐比特一致（见 `same-script-same-result`） |
| `ctx` 走 Proxy，内部 `_` 成员直通 | 严格模式不误伤实现细节 |

Z-axis 保真度：`fillRect/strokeRect/clearRect/drawImage/getImageData/putImageData/beginPath+fill(非零环绕扫描线)/stroke/clip(矩形)/createLinearGradient/createRadialGradient/save/restore/translate/scale/rotate/transform/globalAlpha/source-over·lighter·copy·destination-out…` 均已实现；`fillText` 故意不实现（契约要求用位图字体），调用会留 violation 并在 PNG 上画洋红占位块。

PNG 写入器 `tools/png.mjs` 只用 `node:zlib`，已用**.NET System.Drawing 独立解码**逐像素比对通过（非自证）。

---

## 1. 逐项证据（命令 → 期望 → 实际）

### 1.1 关键节点帧（`.verify/frames/`，1152×648 = 384×216 整数 3× 放大后的真实呈现路径）

复现：`node tools/render-frames.mjs`（脚本化输入：真实键盘事件派发 → INPUT → GAME）

| 帧 | 实测 mode | stage | 非纯色 | 色数 | 主色占比 | mean | 说明 |
|---|---|---|---|---|---|---|---|
| diag-sprites | diagnostic | – | ✓ | 127 | 0.83 | [27,24,33] | 全部精灵拼图（背景占比高属正常） |
| 01-title | title | 0 | ✓ | 1307 | – | [39,23,49] | |
| 02-select | **select** | 0 | ✓ | 988 | – | [34,20,43] | 关卡选择菜单 |
| 03-countdown | countdown | 0 | ✓ | 3602 | – | [74,50,70] | |
| 04-race-start | race | 0 | ✓ | 3639 | – | [76,52,72] | |
| 05-race-fast | race | 0 | ✓ | 4096 | – | [92,68,90] | HUD: TIME/SCORE/LAP/SPEED/GEAR/RPM |
| 06-offroad | race | 0 | ✓ | 4096 | – | [76,53,74] | `offRoad` 已置位 |
| 07-crash | race | 0 | ✓ | 4096 | – | [136,120,134] | 撞车闪白（最亮帧） |
| 08-paused | **paused** | 0 | ✓ | 1818 | – | [43,31,50] | Esc 暂停菜单 |
| 09-stage2 | race | **1** | ✓ | 2023 | – | [35,33,59] | 画面文字 **NEON NIGHT / STAGE 2** |
| 10-stage3 | race | **2** | ✓ | 4017 | – | [97,72,71] | 画面文字 **SANDSTORM / STAGE 3** |
| 11-stageclear | **stageclear** | 2 | ✓ | 1946 | – | [39,44,46] | |
| 12-gameover | **gameover** | 0 | ✓ | 1869 | – | [56,32,42] | |

期望：每个关键节点一张非纯色 PNG，且 mode/stage 与脚本意图一致。
实际：**13/13 全部非纯色；12 张 gameplay 帧的 mode/stage 全部符合**（脚本现在把 mode/stage 不符直接计入 `missingFrames`，
并会让 `render-frames.mjs` 以退出码 3 失败——正是这条规则在 22:31 那轮抓出了"卡在 select 界面"的错误帧集，那批已作废重出）。

### 1.2 三关主题一致性（Lead 指定断言）

期望：每关渲染帧的主色必须与 `CORE.THEMES[key]` 的天空/地面色相符，且三关两两不同。
实际（`render.draws-each-stage-theme`，在**未叠加 CRT 的 low 画质**上取天空带 y∈[44,95) 逐像素"最近调色板"投票）：

```
stage1=sunset sky-votes[sunset:95% night:1% dawn:3%]
stage2=night  sky-votes[sunset:3% night:92% dawn:5%]
stage3=dawn   sky-votes[sunset:0% night:2% dawn:98%]
pairwise s1-s2:94%  s1-s3:89%  s2-s3:95%  (像素差异比例, 阈值 >15%)
```
另有人工视觉确认：09-stage2 = 深蓝夜空+条纹月亮+松树剪影；10-stage3 = 沙尘棕黄天空+仙人掌+石拱+岩石。**三关主题正确且互不相同。**

### 1.3 契约-模块测试（节选，全部 PASS）

| 测试 | 期望 | 实际 |
|---|---|---|
`core.selftest-all-green` | CORE.selfTest 全绿 | 24/24 ✓
`core.tuning-values-match-contract` | §2 全部数值精确 | 逐项精确（CAMERA_DEPTH 0.8391）✓
`core.state-shape` | §7.1 全部字段 | 65 个字段齐全 ✓
`road.build-shape` | segments ≥1200、trackLength、theme 同一性 | 三关 ✓（1635/1613/… 段）
`road.segment-fields-and-closure` | index/dark/curve 合法、首尾闭合 | gap=0 ✓
`road.checkpoints-contract` | 升序、首个=0、**末项=首项（终点线）** | `[0,403,806,1209,0]` ✓（见 2.1）
`road.cars-are-valid` | z/offset/speed/w/h/sprite 全部合法 | 70 辆车全通过 ✓
`road.project-perspective` | §3 透视公式 | camera.*/scale 精确；screen.x/y/w 取整（WARN，见 2.4）
`road.build-is-deterministic` | 同关卡两次构建一致 | ✓
`sprites.required-keys-exist` | §4 全部 28 个 key | 全部存在 ✓
`sprites.nominal-sizes` | 48×27 / 44×24 / 场景 ≤96 宽 / 24×24 FX | ✓（shadow 为扁平阴影，单独规则）
`sprites.sprites-are-not-placeholders` | 无空图/单色图 | ✓
`sprites.catalogue-sets` | SCENERY/OPPONENTS/HERO 引用合法 | ✓
`audio.safe-without-audiocontext` | 无 AudioContext 时全部方法 no-op | 20 个调用零异常，`ready` 假 ✓
`audio.works-with-a-mock-context` | init 建图、master gain ≤0.35 | 建图 ✓、gain 峰值合规 ✓
`input.keyboard-mapping` | ←→↑↓ 与 A/D/W/S | ✓
`input.edge-triggering` | 边沿只消费一次、长按不重复触发 | ✓
`input.reset-clears-everything` | reset 清空 | ✓
`input.touch-and-gamepad` | 触摸与手柄可用 | 触摸 steer=-0.86、手柄 steer=0.90 ✓
`integration.index-html-load-order` | index.html `<script src>` 顺序 = CONTRACT §0 | core→road→sprites→audio→render→input→game ✓
`integration.only-contract-globals-exposed` | 只暴露 7 个全局 | `AUDIO,CORE,GAME,INPUT,RENDER,ROAD,SPRITES`，无多余 ✓
`integration.module-isolation` | render 不读 GAME/INPUT/AUDIO；road 不碰 canvas | ✓
`game.raf-loop-drives-update-and-render` | GAME 自持 rAF 循环并真的出图 | ✓（40 帧后可见画布 distinct>2）
`game.title-to-race-flow` | title→select→countdown→race | ✓
`game.offroad-decelerates-and-flags` | \|playerX\|>1 限速 + 标志 | ✓（speed ≤ OFF_ROAD_LIMIT×1.35）
`game.collision-sets-crash-fx` | 撞车可达并有 shake/flash/无敌帧 | ✓
`game.pause-and-resume` | Esc 冻结仿真与计时 | ✓（position/timeLeft 逐帧不变）
`game.timer-expiry-goes-gameover` | 计时归零 → gameover | ✓ + results 对象
`game.stage-advance-switches-theme-and-track` | 完赛后 theme/track 切换 | sunset→night ✓（实测 theme.key 与 track.name 均变）
`game.extreme-dt-is-safe` | dt ∈ {0,-1,1e-9,0.25,1,5,NaN,Infinity} | 无异常、无 NaN、speed/playerX/position 均在界内 ✓
`game.resize-is-safe` | 1920×1080→2560×1440 等 5 种尺寸 + resize 事件 | ✓
`game.soak-10800-frames` | 3 分钟等效帧数 | **10800 帧 update + 360 帧实渲染，0 异常、0 NaN、state.errors 空、0 张纯色** ✓
`game.no-console-errors-during-play` | 全程无 console.error/warn | 0 ✓
`game.shim-violations` | 无 network/unknown-ctx/Math.random/shadowBlur/fillText | 0 ✓
`integration.same-script-same-result` | 两次相同 600 帧脚本结果一致 | 摘要哈希一致 ✓（重载全部 src 后重跑）
`integration.frames-on-disk-are-current` | PNG 与当前 src 版本一致 | ✓（srcHashes 比对 + 无 stale 标记）

### 1.4 人工看图结论（逐张，1152×648）

| 帧 | 目视结论 |
|---|---|
| 01-title | `NEON DRIFT '86` 三色标题 + ARCADE RACING + ENTER TO START + INSERT COIN 闪烁 + 山脉/日落背景，**字体清晰**。注意：此屏**没有画菜单列表**（见 2.3） |
| 03-countdown | 起跑倒计时，路面透视正确、车道虚线/路肩正常 |
| 05-race-fast | HUD 六块（TIME/SCORE/LAP/SPEED/GEAR/RPM）全部可读；太阳被山脉遮挡的层次正确；棕榈树有接地阴影；AI 车在各自车道内、无穿模；远处雾化合理 |
| 06-offroad | 车身偏出道路、屏幕抖动、越野标志出现 |
| 07-crash | 撞车白闪 + CRASH 提示，AI 车与玩家车重叠瞬间合理 |
| 08-paused | Esc 暂停菜单（RESUME/RESTART/QUIT）绘制正常 |
| 09-stage2 | **NEON NIGHT / STAGE 2**：深蓝夜空 + 条纹月亮 + 松树剪影 + 青/品红路肩 + 霓虹广告牌 |
| 10-stage3 | **SANDSTORM / STAGE 3**：沙尘棕黄天空 + 沙地 + 仙人掌 + 岩石 + 石拱门 + 棕榈 |
| 11-stageclear | STAGE CLEAR 结算屏可读 |
| 12-gameover | 时间到 / 结算屏可读 |

未发现精灵悬空、错位或穿模；三关主题一次看过去完全不同。唯一系统性问题是整幅偏暗（见 2.2）。

---

## 2. 已知问题清单（含严重级别与复现）

### 2.1 [已修复/已复核] 关卡推进与 `Track.checkpoints` 终点线语义 — ~~HIGH~~ → 已闭环

- **现象（当时）**：我早期导出的 09/10 帧 HUD 仍写 `SUNSET STRIP / STAGE 1`。
- **判定**：**测试脚本失效（a）**，但根因是 road.js 缺少契约要求的尾部终点线项。
  - 当时 `ROAD.build(0).checkpoints = [0,403,806,1209]`，而 `game.js:checkCrossings/onCheckpoint` 在
    `i === cps.length-1` 时才 `completeLap()` → **过起点线（segment 0）不算圈**，只在 75% 处算圈。
  - 我的白盒强制完赛把车放在 `trackLength-240`（起点前），因此**永远完不成一圈**，stageIndex 不变 → 09/10 确实是同一关的截图。
  - `game.js` 自带 fallback 数据 `[0,300,600,900,0]` 也印证契约意图：末项 = 首项 = 终点线。
- **复现命令**：`node .verify\_probe-stage.mjs`
  - **当时**（road.js 未修）：输出 `checkpoints=[0,408,817,1226]`（另一版为 `[0,403,806,1209]`），把车放到 `trackLength-240` 并跨过起点线后 `lap` **不变**、`stageIndex` **不变**。
  - **现在**（road.js 已修，同一条命令）：输出 `checkpoints=[0,408,817,1226,0]`，同样把车放到 `trackLength-240` 跨线后直接得到
    `mode=stageclear results={"fin":true,"stage":"SANDSTORM"}` —— 终点线语义恢复，**一跨线即完赛**。
- **现状**：断言 `road.checkpoints-contract` 转 **PASS**；
  本报告全部帧已按 `checkpoints[last]` 重新强制并实测 `stage 0→1→2`（`forceStageAdvance: … stage 0 -> 1`、`stage 1 -> 2`），
  视觉确认 `09-stage2.png` = NEON NIGHT / STAGE 2、`10-stage3.png` = SANDSTORM / STAGE 3。**该问题已闭环。**

### 2.2 [已修复/已复验] CRT pass 不是"subtle"，而是整屏压暗 tint — ~~HIGH~~ → 已闭环

- **位置**：`src/render.js` CRT 段（`chromaPass` / `tearPass` / `drawCrt`）
- **复现**：`node tools/contract-test.mjs` → `render.crt-stays-subtle`；细节测量 `node .verify\_probe-crt.mjs`
- **期望**（CONTRACT §6）："1-in-N scanlines、2-px edge vignette、subtle vertical chroma shift、occasional tear line"；DoD#2 要求 CRT 开启仍达 60fps。
- **当时实际**：
  - 平均亮度：sunset 71.7→**29.1（×0.41）**、night 47.4→22.0（×0.46）、dawn 84.6→32.8（×0.39）
  - **逐行比值恒定 0.31~0.32**（median=0.32）——没有隔行 scanline 结构，等效约 68% 不透明暗色叠加
  - 后果：主题亮色被抹掉；CRT 段占整帧耗时 **23.07 ms / 75%**（见第 3 节）
- **engine 的修复**（render.js 22:31 版）：重写 `chromaPass`，把三通道分离绘制改为"同通道原位权重 1 + 位移 0.12"，
  源码注释明确写出 "splitting it renders the entire world layer at one third brightness"。
- **复验结果**：
  - 断言 `render.crt-stays-subtle` **PASS**（三关亮度保留 ≥60%）
  - 帧数据：`05-race-fast` mean 由 [50,43,52] → **[92,68,90]**；`10-stage3` 由 [38,31,32] → **[97,72,71]**
  - 目视 `05-race-fast.png`：橙黄太阳、紫→橙渐变天空、粉白路肩、青蓝路面全部恢复，且**扫描线仍在**（路面/天空可见横向明暗带）→ CRT 观感保留、压暗消失。**已闭环。**

### 2.3 [已修复/已复验] 标题菜单既不可导航、也没有绘制 — ~~MEDIUM~~ → 已闭环

- **位置**：`src/game.js` `stepTitle`（当时 828 行）+ `src/render.js` title 分支（当时 1178-1195 行）
- **当时实际**：
  1. 按一次 `↓` → `pressed('down')` 先把 menuIndex 0→1，紧接着 `anyPressed()` 为真（`INPUT.onKeyDown` 对非静默键置 `anyEdge`），立刻 `activateMenu()` → **光标从未在标题菜单停留**，`SELECT STAGE / QUALITY / SOUND` 键盘不可达。
  2. 标题屏只画 logo / PRESS ENTER TO START / 提示 / INSERT COIN / 版权，随后 `return`，**从不绘制 `state.menuItems`**；玩家看不到有 4 个选项。
  3. 连带：`toggleQuality()` 只能经标题菜单 `'quality'` 项触发 → 当时**画质切换不可达**（LOW）。
- **gameplay 的修复**（game.js 22:30 版）：方向键现在只移动光标并停留在 title。
- **复验结果**（`node .verify\_probe-regress.mjs`）：
  ```
  title    mode=title  menuIndex=0   （按 ↓ 之前）
  ↓
  title    mode=title  menuIndex=1   （按 ↓ 之后：模式不变，光标移动 ✓）
  Enter →  mode=select  menuItems=["SUNSET STRIP","NEON NIGHT","SANDSTORM"] ✓
  Enter →  mode=countdown ✓（开赛）
  ```
  **该问题已闭环。**（我的帧导出脚本也因此从"按一次 ↓ 就当已选关"改成"↓ 后按 Enter、必要时重按"的鲁棒流程。）

### 2.4 [LOW] `ROAD.project()` 把 screen.x/y/w 取整，偏离 §3 原式

- **位置**：`src/road.js:408-410` `Math.round(...)`（`screen.scale` 与 `camera.*` 仍精确）
- **复现**：`node tools/contract-test.mjs` → `road.project-perspective` **WARN**
- **期望**：§3 给出的公式（未取整）。
- **实际**：screen.x/y/w 为整数（像素对齐）。对像素画是合理取舍，且不破坏渲染，**故只记 WARN 不判 FAIL**；若要严格合规，建议在契约里显式写明"screen.* 允许整数吸附"。

### 2.5 [INFO] `12-gameover.png` 的 `SCORE 0000000` 属设计而非缺陷

`game.js:609`（`startStage`）里 `state.score = 0` —— 分数按关重置；`state.best` 是跨局持久值（`game.js:197/696`）。
该帧是脚本把 `timeLeft` 强设 0.05s 后立即超时，故 score=0、BEST=0026360（来自之前已完成的关卡）。若产品上希望 gameover 展示累计分，需 gameplay 改设计。

### 2.6 [INFO] 白盒强制完赛（帧导出的已知手段）

09/10/11 三帧的关卡推进是**白盒**完成：读 `state.checkpoints[last]`，把 `position` 放到终点线前 300 单位、
`lap=laps`，再让物理跨线。真·自动驾驶连续跑两圈在 1152×648 软渲染下每次要 4-5 分钟，故默认不走；
需要"真跑"证据时用 `node tools/render-frames.mjs --real-race`（预算 4200 帧/关）。
真正"完赛即切关"的逻辑另有 `game.stage-advance-switches-theme-and-track` 断言覆盖。

### 2.7 [WARN] index.html 含 1 个 inline `<script>`

`integration.index-html-load-order` 已断言 7 个外链脚本顺序与 CONTRACT §0 完全一致（PASS）；
另有 1 个 inline 块（WARN）。打包器（`tools/build.mjs`）合并时须保持经典脚本顺序，勿重排。

---

## 3. 性能（task-5 第 4 项：draw 调用数与每帧耗时）

复现：`node .verify\perf-probe.mjs`（race 中 120 帧取均值；384×216 可见画布 = 1× 整数放大）

| 画质 | 每帧 Canvas 调用 | 每帧耗时 | 其中 ctx 调用 | 其中 JS 逻辑 |
|---|---|---|---|---|
| **high（CRT 开）** | **699** | **28.14 ms** | 26.08 ms（drawImage 19.66 / fillRect 5.93 / clearRect 0.49） | 2.06 ms |
| **low（CRT 关）** | 637 | 6.74 ms | 4.70 ms（drawImage 3.23 / fillRect 1.47） | 2.04 ms |

- 调用次数 **699 < 6000**，未触及告警线；CPU 侧每帧 28.1 ms **超过 8 ms 阈值 → 必须报热点**。
- **热点：CRT pass。** 开/关画质差 **21.40 ms/帧 = 整帧的 76%**，但只多出 12 次调用
  （223-211）→ 说明它是**几次全屏 drawImage**（三通道色散位移 + 暗角合成），而不是大量小调用。
- 其余开销：drawImage 合计 211 次/帧（AI 车 + 路侧精灵 + HUD 字形），本 shim 每次约 15 µs（纯 CPU 最近邻缩放）。
- **注意**：这是 Node 里的**软件光栅化**耗时，**不能**直接换算成浏览器帧率（浏览器 drawImage 走 GPU，
  且真实分辨率下 letterbox 缩放也是 GPU 完成）。它只能证明"CRT 是主要开销"，DoD#2 的真机 60fps 仍需人工在浏览器里确认。

---

## 4. 残余风险（本环境无法闭环的部分）

1. **浏览器真实行为**：`file://` 双击打开、真实 CSS 布局/letterbox、真实键盘焦点、`localStorage` 持久化跨会话、真实触摸/手柄驱动 —— 均无法在本沙箱验证；垫片只保证"逻辑与像素"层面。
2. **60fps（DoD#2）**：Node 是 CPU 软渲染，测得 high 28.1 ms/帧、low 6.7 ms/帧（1× 画布），**只能说明 CRT 是主要开销，不能推断浏览器帧率**。建议 Lead 在真机上目测一次（`M`/`F` 键可用，画质项见 2.3）。
3. **音频听感**：只能用 mock AudioContext 验证"不抛异常/建图/gain 峰值 ≤0.35/静音生效"，音色、无缝循环、失谐等听感项无法自动判定。
4. **CRT 之外的美术主观项**（像素风格统一、字体可读性）需人工看图确认。
5. **多浏览器**：仅验证了 ES5 语法与现代 Node（V8 24.x）；未跑 Firefox/Safari。

---

## 5. 交付物与复现命令

| 文件 | 作用 |
|---|---|
| `tools/canvas-shim.mjs` | Canvas2D + 最小 DOM 垫片（严格模式、绊线、虚拟时钟） |
| `tools/png.mjs` | 纯 zlib PNG 编码 + 图像统计（非纯色/主色/像素差/主题距离） |
| `tools/loader.mjs` | 按 index.html 顺序 `vm` 加载 src、全局泄漏检测、NaN 扫描、Driver |
| `tools/render-frames.mjs` | 脚本化输入推帧 → `.verify/frames/*.png` + `manifest.json`（带 srcHashes） |
| `tools/contract-test.mjs` | 61 项断言（含 soak 与跨运行确定性），失败退出码非 0 |
| `tools/run-all.mjs` | 一键跑完并打印 PASS / PASS WITH ISSUES / INCOMPLETE / FAIL |

```powershell
$node = "C:\Users\wanji\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe"
cd "D:\V4.1F Test"

& $node tools\run-all.mjs --full-soak      # 全套：61 项断言 + 10800 帧 soak + 12 张帧（约 2.5 分钟）
& $node tools\run-all.mjs                  # 快速档（soak 仍为 10800 帧 update + 360 帧实渲染）
& $node tools\contract-test.mjs            # 只跑断言
& $node tools\render-frames.mjs            # 只出帧
& $node tools\render-frames.mjs --real-race --budget=4200   # 真·自动驾驶跑圈（慢）
```

退出码：`0` = PASS / PASS WITH ISSUES，`1` = FAIL，`3` = INCOMPLETE（有模块缺失或帧缺失/纯色）。

`.verify/` 下的探针是为定位上述问题写的一次性脚本，保留作为**可复现证据**：

| 探针 | 用途 |
|---|---|
| `.verify\_probe-regress.mjs` | 标题菜单行为（问题 2.3 复验：↓ 只移动光标，Enter 才生效） |
| `.verify\_probe-stage.mjs` | 关卡推进与 `checkpoints` 终点线语义（问题 2.1，含修复前后对比） |
| `.verify\_probe-crt.mjs` | CRT 压暗测量：逐像素 high/low 比值、主题投票（问题 2.2） |
| `.verify\_probe-theme.mjs` | 三关主题主色/色调分布投票（问题 1.2） |
| `.verify\perf-probe.mjs` | 每帧 draw 调用数与耗时拆分（第 3 节） |
| `.verify\_runall*.log` | 历次 run-all 原始输出（含发现回归/过时帧的那几轮） |

### 验证过程中被绊线抓到的两次"帧过期"

1. **22:31 版**：`frames-on-disk-are-current` 报 `src/ changed (render, game)` → 重出全部帧。
2. **22:38 版**：脚本自身的菜单假设过期（gameplay 修好标题菜单后，↓ 不再直接进选关），
   导致 6 个 GAME 断言假失败 + `07-crash` 帧 mode 实测为 `select`。
   我把 `mode/stage 不符` 升级为**硬失败**（帧脚本退出码 3），修好导航后重跑全绿。
   —— 这正是"帧必须对应当前 HEAD"的价值：**过时/错位的帧进不了最终结论**。

---

*报告生成：verifier；数据取自同一次运行的 `.verify/frames/manifest.json` 与 `.verify/contract-test.json`（src revision `8990437474dedd08`）。*

---

*报告生成：verifier；数据取自 `.verify/frames/manifest.json` 与 `.verify/contract-test.json`（同一次运行）。*
