# dsh-file-review-tab

> **前置依赖**：DeepSeek Harness web（**0.2.0-rc.2+**，已在 0.2.0-rc.2 上真机验证）+ [dsh-better-sidebar](https://github.com/omdsh-dev/DSH-better-sidebar)（≥ 0.19.1，已在 0.24.1 上验证）。仍停留在低版本 DSH 的用户请按 [版本对应](#版本对应) 选择插件版本。
>
> **Requirements**: DeepSeek Harness web (**0.2.0-rc.2+**, verified on 0.2.0-rc.2) + [dsh-better-sidebar](https://github.com/omdsh-dev/DSH-better-sidebar) (≥ 0.19.1, verified on 0.24.1). On an older DSH, pick the plugin version per [version mapping](#版本对应).

把 [dsh-file-review](https://github.com/left0ver/dsh-file-review)（作者 [left0ver](https://github.com/left0ver)）的"改动审查"能力移植为 [dsh-better-sidebar](https://github.com/omdsh-dev/DSH-better-sidebar) 的侧边栏 Tab，并保留对话尾部的审查行——两个入口同源，互不干扰。

> Port of [left0ver/dsh-file-review](https://github.com/left0ver/dsh-file-review)'s change-review capability into a [dsh-better-sidebar](https://github.com/omdsh-dev/DSH-better-sidebar) sidebar tab, keeping the chat turn-tail review row.

> **镜像说明**：本仓库（[whybebabo/dsh-file-review-tab](https://github.com/whybebabo/dsh-file-review-tab)）是 [Lzh3070/dsh-file-review-tab](https://github.com/Lzh3070/dsh-file-review-tab) 的 **fork 镜像**，保留其完整提交历史与原插件名（未改名）。基线 commit 为 `1de22fc`（上游 `main` 头部，版本 `0.5.0`，面向 DSH 0.1.5）；本仓库在其之上带有 19 个提交（面向 DSH 0.2.0），并以 **`@whybebabo/dsh-file-review-tab`** 发布到 npm。**npm 上的裸名 `dsh-file-review-tab` 由上游作者持有**（维护者 `phynez_1103`，最高 `0.5.0`），本仓库无权也未曾发布到该名下——因此想装本仓库版本必须使用带 scope 的包名，见 [安装](#安装)。上游若更新，其 `main` 与裸名 npm 包仍应视为权威。
>
> **Mirror notice**: this repository ([whybebabo/dsh-file-review-tab](https://github.com/whybebabo/dsh-file-review-tab)) is a **fork** of [Lzh3070/dsh-file-review-tab](https://github.com/Lzh3070/dsh-file-review-tab) with the same commit history and the same plugin name (no rename). Its baseline commit is `1de22fc` (upstream `main` head, version `0.5.0`, targeting DSH 0.1.5); this fork carries 19 further commits (targeting DSH 0.2.0) and publishes to npm as **`@whybebabo/dsh-file-review-tab`**. The **bare npm name `dsh-file-review-tab` is owned by upstream** (maintainer `phynez_1103`, highest `0.5.0`), so a fork release must use the scoped name — see [Install](#安装). Treat upstream's `main` and its bare-name npm package as canonical.

## 与上游的差异

本 fork 相对上游 `main`（`1de22fc`，`0.5.0`）的差异集中在"面向 DSH 0.2.0 的适配"与"本 fork 自己的发布决策"两类：

| 项 | 上游 `dsh-file-review-tab@0.5.0` | 本 fork `@whybebabo/dsh-file-review-tab@0.7.0` |
|---|---|---|
| 目标 DSH | 0.1.5 | **0.2.0-rc.2** |
| Typert 编解码 | 旧 `schema:` 形状（0.2.0 注册即抛错） | 严格 `TypertCodec.create()` 工厂 |
| 对话尾部槽位 | `turnTail` 链式（`select` + `priority`，首个声明者胜） | `turnTail` **加法列表**（`id` + `order`，多入口共存） |
| 尾部改动卡片 | 自定义卡片 | **原生 ui-deliverables 卡片同款外观** + 撤销/审查两个按钮 |
| 侧边栏 Tab 表头 | 自定义 | 原生 38px 对照条 + 分栏/换行/刷新工具行（各带 500ms 提示） |
| 自动归档 | 无 | 主列表保留最近 5 轮，更早轮次折叠分页（每页 10 轮） |
| 删除文件可见 | 无 | 解析 `rm` 族命令字面路径，标记「已删除」 |
| Code Mode（PTC） | 无 | `run_code` 子调用被捕获并入所属轮次 |
| npm 包名 | `dsh-file-review-tab` | **`@whybebabo/dsh-file-review-tab`**（裸名由上游持有） |

**不要同时安装两者**：两个包注册同一个 `turnTail` 槽位与同一个 `ui-deliverables` 补丁（都会禁用内置 ui-deliverables 行），共装会出现重复卡片。


## 功能

- **对话尾部审查行（与原生同款外观）**：回合结束出现「已编辑 N 个文件 +M −K」卡片，其外观**逐像素对齐 DSH 内置的 ui-deliverables 改动卡片**——同一个 60px 头部、40px 文件类型图标块、13px 标题、悬停时 `+N −K` 让位给「在侧边栏预览」、等宽字体文件行、超过 4 行折叠为「全部 N 个文件」，并同样复用官方的 `FileTypeIcon` / `HoverCard` / 折叠箭头。差异只有一处：**头部右上角多出「撤销（撤销后可点「重新应用」）与「审查」两个按钮**——内置卡片标题栏没有任何插槽，所以本插件自渲染同款卡片以容纳这两个按钮。鼠标悬停 500ms 即弹出该文件的 diff 预览；点「审查」或单个文件名，**深链打开侧边栏 Tab，自动展开对应文件的 diff 并定位到该轮分组顶部**（不再弹全宽 drawer）。
- **侧边栏 Tab「文件审查」**：按轮次分组列出本会话改动文件；点击展开行级红绿 diff；支持撤销本轮 / 单文件撤销 / 重新应用；Tab 角标实时显示改动文件数。表头是与原生同款的 38px 对照条（文件选择器 + 统计），工具行提供「分栏 / 换行 / 刷新」三个可切换/可用的控件，每个都带 500ms 提示气泡。
- **删除文件可见**：dsh 没有删除文件的工具，删除发生在终端命令里——插件解析 `rm` 族命令（`rm` / `rmdir` / `unlink` / `shred` / `trash` / `Remove-Item` / `del` / `rd` / `erase` 等）的字面路径参数，被删文件以「已删除」标记出现在两个入口（内容已不存在，故无行级 diff、不可撤销）。带通配符（`rm *.log`）或命令替换（`rm $(...)`）的删除不识别——受影响文件事后无法枚举。
- **自动归档**：主列表只保留最近 5 轮（进行中的轮次永不归档），更早的已完成轮次沉入底部「已归档 N 轮」折叠区。折叠时归档内容零渲染，展开后每页加载 10 轮（「加载更多」续页），diff 行另有懒挂载——长会话不再一次性挂载几十个 diff 组。深链跳到已归档轮次会自动展开并定位；展开状态按会话记忆；角标只统计主列表。
- **PTC / Code Mode 支持**：`run_code` 程序内部的 `edit`/`write` 子调用也会被捕获——Host 端快照完整 before/after，浏览器端重建带行号的行级 hunks 并入所属轮次；diff 查看、状态检查、撤销/重做均可用。标准模式行为不变（对话尾部审查行仍只覆盖标准模式轮次）。
- **会话隔离**：每个会话只看自己的改动；Tab 不可见时暂停状态巡检。
- **窄容器自适应**：工作台横向分屏半宽或浮动独立窗口下，轮次头部自动换行、次要信息（行数统计、「在编辑器中打开」）让位，撤销操作与文件名始终完整。
- **样式隔离**：全部 CSS Module + 宿主 `--dsw-alias-*` 主题令牌，不与对话区或其他插件冲突。

![在 dsh 中查看本轮文件改动：按文件展开的新增/删除对比](https://raw.githubusercontent.com/whybebabo/dsh-file-review-tab/main/docs/show.png)

## 安装

```sh
# 本 fork 的发布版（scoped 包名）
dsh plugin --profile web add @whybebabo/dsh-file-review-tab

# 或直接从本仓库的 GitHub 源安装（与 npm 发布同源）
dsh plugin --profile web add github:whybebabo/dsh-file-review-tab

# 上游版本（DSH 0.1.5，功能较少、无 0.2.0 适配）
dsh plugin --profile web add dsh-file-review-tab@0.5.0
```

> ⚠️ 裸名 `dsh-file-review-tab` 在 npm 上由**上游作者**持有。`dsh plugin --profile web add dsh-file-review-tab` 装到的是上游 `0.5.0`（DSH 0.1.5），**不是**本仓库的 `0.7.0`——要装本 fork 的版本必须用上面的 scoped 名或 GitHub 源。

`dsh plugin` 会把参数转发给 profile 目录下的 pnpm，所以 `github:owner/repo` 这类 pnpm 支持的源都可用。

装好后**重启 `dsh web`**，在 better-sidebar 侧边栏「+」菜单打开「文件审查」即可。`dsh-better-sidebar` 是前置依赖、不会随本插件自动装上，需另行安装（`dsh plugin --profile web add dsh-better-sidebar`）。

> 刚发布的版本首次安装可能被 pnpm 的 `minimumReleaseAge`（默认 24 小时）挡下——用**精确版本**可绕过：`dsh plugin --profile web add @whybebabo/dsh-file-review-tab@0.7.0`。

### 版本对应

`@whybebabo/dsh-file-review-tab@0.7.x` 面向 DSH 0.2.0（服务端严格的 `TypertCodec.create()` 工厂 + `conversation.chat.turnTail` 加法列表槽 + 原生同款改动卡片），也是本 fork 唯一的 npm 发布版本；仍停留在 DSH 0.1.5 的用户请使用上游的 `dsh-file-review-tab@0.5.x`，DSH 0.1.2 / 0.1.1 请用上游 `0.4.1`。本 fork 未发布 `0.6.x`（其提交含在 0.7.0 历史中）。

## 致谢

本 fork 的上游是 [Lzh3070/dsh-file-review-tab](https://github.com/Lzh3070/dsh-file-review-tab)（`1de22fc` 基线），本仓库的 DSH 0.2.0 适配与侧边栏能力均在其之上构建。核心 diff 渲染器与撤销服务移植自 [left0ver/dsh-file-review](https://github.com/left0ver/dsh-file-review)（MIT License, © ZhangWenChao）。侧边栏集成基于 [dsh-better-sidebar](https://github.com/omdsh-dev/DSH-better-sidebar) 开放的 `ctx.betterSidebar` 注册 API。

## License

[MIT](./LICENSE)

---

## Differences from upstream

Relative to upstream `main` (`1de22fc`, `0.5.0`), this fork differs in two ways: DSH 0.2.0 adaptation, and this fork's own publishing decision.

| | Upstream `dsh-file-review-tab@0.5.0` | This fork `@whybebabo/dsh-file-review-tab@0.7.0` |
|---|---|---|
| Target DSH | 0.1.5 | **0.2.0-rc.2** |
| Typert codecs | legacy `schema:` shape (0.2.0 rejects it at registration) | strict `TypertCodec.create()` factories |
| Turn-tail slot | `turnTail` chain (`select` + `priority`, first claim wins) | `turnTail` **additive list** (`id` + `order`, entries coexist) |
| Turn-tail card | custom card | **native ui-deliverables look** + undo/review buttons |
| Sidebar tab header | custom | native 38px comparison bar + split/wrap/refresh tools (500ms tooltips) |
| Auto-archive | none | newest 5 turns inline; older turns fold into a paged section (10/page) |
| Deleted files | not surfaced | literal `rm`-family paths marked "deleted" |
| Code Mode (PTC) | none | `run_code` sub-calls recorded into their owning turn |
| npm name | `dsh-file-review-tab` | **`@whybebabo/dsh-file-review-tab`** (bare name held by upstream) |

**Do not install both.** Each registers the same `turnTail` slot and disables the built-in `ui-deliverables` row, so installing both yields a duplicated card.

## Features (English)

- Chat turn-tail review row that mirrors the built-in ui-deliverables changes card (same 60px header, file-type tile, hover preview, 4-row fold with "All N files") and adds the two buttons the built-in header cannot host: undo/reapply and review. It deep-links into the sidebar tab (auto-expanding the diffs and scrolling the turn group to the top) instead of a full-width drawer.
- Sidebar tab "File Review" in dsh-better-sidebar: per-turn grouped changed files, line-level red/green diffs, undo per turn or per file, live badge with the changed-file count. Its header is the native 38px comparison bar (file selector + counts) with a split / wrap / refresh tool row, each control carrying a 500ms tooltip.
- Deleted files stay visible: dsh has no delete-file tool, so deletions happen in terminal commands — literal `rm`-family arguments (`rm`, `rmdir`, `unlink`, `shred`, `trash`, `Remove-Item`, `del`, `rd`, `erase`, …) are parsed and deleted files appear marked "deleted" in both surfaces (no line diff, no undo: the content is gone). Glob/command-substitution deletions are not guessed.
- Auto-archive: only the newest 5 turns stay in the main list (live turns never archive); older completed turns sink into an "Archived turns" section pinned to the tab's bottom. Collapsed it renders nothing; open, it loads 10 turns per page. Deep links auto-open and page to their target; the badge counts the main list only.
- Code Mode (`run_code`) support: sub-calls dispatched inside a program are snapshotted host-side and rebuilt into numbered line-level hunks in their owning turn, so diff viewing, state checks and undo/reapply all work there too. Standard-mode behavior is unchanged.
- Session-isolated, pause-when-hidden, CSS-Module scoped styling (no conflicts with the chat area or other plugins).
- Narrow-pane adaptive: in half-width splits and floated free windows the turn header wraps and secondary content yields so undo and file names never clip.

Requires DeepSeek Harness web (0.2.0-rc.2+, verified on 0.2.0-rc.2) and dsh-better-sidebar (≥ 0.19.1, verified on 0.24.1), the latter installed separately. Install this fork from npm (`dsh plugin --profile web add @whybebabo/dsh-file-review-tab`) or from this repo's GitHub source (`dsh plugin --profile web add github:whybebabo/dsh-file-review-tab`). `0.7.x` targets the DSH 0.2.0 client API (strict `TypertCodec.create()`, additive `turnTail` list slot, native-identical changes card) and is this fork's only npm release; the bare name `dsh-file-review-tab` on npm belongs to upstream and is still `0.5.0` for DSH 0.1.5, so installing the bare name does not get this fork's version. Users on DSH 0.1.5 should stay on upstream `0.5.x`, and DSH 0.1.2 / 0.1.1 on `0.4.1`. Restart `dsh web` after installing, then open the "File Review" tab from the sidebar's "+" menu. If a freshly published version is held back by pnpm's `minimumReleaseAge` (24 h default), pin it exactly: `@whybebabo/dsh-file-review-tab@0.7.0`.

## Development

```sh
pnpm install
pnpm typecheck   # tsc --noEmit
pnpm build       # emits lib/ (host ESM + browser bundle + .d.ts)
pnpm test        # runtime checks; run after build
```

`pnpm test` drives the built artifacts through the real DSH 0.2.0 registries rather than mocking them, so a breaking upstream API change fails here instead of in the UI. All nine checks assert behavior no typecheck can see:

- `test/typert-descriptors.mjs` — registers the Host Typert contribution against the real registry and round-trips every codec (plus a control proving the pre-0.2.0 `schema:` codec shape is rejected).
- `test/slot-registration.mjs` — registers the turn-tail entry against the real `SlotCore` (a list slot requires an `id`).
- `test/host-apply.mjs` — runs the host half's `apply()` on a real cordis `Context` and drives the `tools/post-execute` recorder plus the `fileReview` Remote service.
- `test/review-invalidation.mjs` — session-scoped review-state invalidation and disposer behavior.
- `test/diff-hunks.mjs` — the shared diff core (`toNativeHunks`) invariants: numbering, sign prefixes, context trimming.
- `test/client-bundle.mjs` — evaluates `lib/client.js` the way the Web plugin loader does and checks the `dsh.client` contract (`apply` export + `inject` list).
- `test/card-render.mjs` / `test/tab-render.mjs` — actually MOUNT the turn-tail card and the sidebar tab with `react-dom/server`, asserting the native structure and that no button nests inside another.
- `test/diff-render.mjs` — renders the comparison body (unified/split/wrap, hunk banners, per-side line numbers, creation/deletion/empty status lines).
