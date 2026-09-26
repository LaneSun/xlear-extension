# AGENTS.md

Xlear 扩展的开发约定。设计与上手见 `README.md`；服务端在另一个仓库（`xlear`）。

## 尽最大努力（对所有任务生效）

- **自己做完、自己验证**：除下面三类之外，不要把事交回给所有者去做或去验 ——
  1. 必须由他决定的事（对外承诺、花钱、动他的 X 账号、删数据、改产品方向）；
  2. 只有他能提供的信息（例如他账号里的实际内容、他的偏好）；
  3. 真正需要他授权的破坏性操作。
  验证手段是齐备的（CDP 连扩展自己的页面、脚本、构建、测试），**没有理由停在"编译过了"**。
- **验证 = 当前状态下的直接证据**：命令输出、实测读数、DOM/存储对比、真实页面现象。
  拿不到证据时说清缺什么并换手段继续试，**不要用"需所有者操作浏览器"这类话代替验证**。
- **遇到障碍先怪工具与自己的方法，再考虑放弃**：换参数、换入口、换思路；同类失败两次以上就换路子，别重复同一个探针。
- **提交前把门槛跑绿**：`deno task check` / `deno task test` / 扩展 `pnpm run compile` 与两套构建。
- **汇报只给结论与证据**：自己错了就直接说错在哪，不为难处找说法，也不把未验证的东西说成已验证。

## 语言

- 与所有者用中文交流；注释、提交信息与开发文档用中文。
- `README.md` 用英文（面向用户），中文版放 `README.zh.md`，两者内容保持同步。
- 代码标识符、路径、键名用英文；界面品牌一律写 **Xlear**。
- 界面提供中文 / English / 日本語 / Русский，**主要语言是英文**：只有一份、无法按读者切换的内容
  （弹窗标题里的理由文案、注入卡片的说明）按调用方传入的语言渲染。

## 硬性规则
- **不主动操作 X 页面**：所有者的账号与窗口归他本人，需要看 X 上的现象时先问。
  这条只覆盖 X（x.com / twitter.com）；**扩展自己的页面（options / onboarding / popup）属于自查范围** ——
  改完界面或消息链路，应当自己用 CDP 连上去点一遍、量一遍（计算样式、DOM 与实际存储），
  不要停在"编译过了"就交给所有者验。
- 开发期改了扩展代码后，**必须重启浏览器并清掉 `Default/Service Worker` 与 `Default/Code Cache/js`**
  再验：Chrome 会缓存 Service Worker 脚本与页面 chunk，否则量到的是旧构建（本会话被这一点误导过两次）。
- 用 CDP 驱动 Preact 受控输入时，直接赋值 `el.value` 会被覆盖，必须用原生 setter：
  `Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(el, v)` 再派发 `input` 事件。

1. 不使用子 Agent 代工，全部任务由本人完成。
2. 不逆向 X 的请求签名；不硬编码 GraphQL `queryId`；不依赖页面 computed font。
3. 只模拟三类点击，全部由用户逐条发起：
   (a) 用户点卡片上的「在 X 上屏蔽」→ 替其点开该帖的更多菜单与「屏蔽」项，之后 X 弹出它自己的
       确认弹窗，由用户点确认；
   (b) 用户点 X 自己的「屏蔽」项后，我们不改写 X 的行为，只把它的确认弹窗藏起来换成理由弹窗；
   (c) 用户在理由弹窗里点「提交」→ 恢复 X 的弹窗并**代其点下 X 的确认按钮**；
       一条可用名单都没有时**完全不介入**，让 X 自己的屏蔽流程照常走完。
   写请求始终由 X 自己发出；扩展不另发任何 X 写请求。
4. 扩展自己不发写请求：屏蔽与静音一律由用户发起、由 X 发出（含 3(c) 的代点确认）；
   扩展对 X 的行为只有「隐藏帖子」这一项。
5. 界面只讲结果：谁被收录、理由是什么；不展示平台内部的处理过程。
6. 不读取、不记录、不哈希 IP；不留安装 ID 或设备标识。
7. **开发在开发分支上做，main 只跟"要发布的版本"走**：功能与修复开一个 `dev-<主题>` 书签
   （`jj bookmark create dev-<主题> -r @`）在其上提交，不往 main 上堆。
   **只有维护者明确要求升版本时**，才把 main 推到要发布的那个提交（`jj bookmark set main -r @`）
   并打 `vX.Y.Z` 标签；**版本号（`package.json` 的 `version`）也只在维护者明确指示时改**。
   维护者明确要求的流程/文档修正可以直接进 main（这类改动不发版）。

## 工具链

Node 22+ 与 pnpm：`pnpm install` · `build` · `build:firefox` · `zip:firefox` · `compile`。
必须用 Node/pnpm：WXT 的 `resolve-config.mjs` 在 Deno 下会报 `Invalid arguments`。

## 扩展注意事项
- 理由弹窗**只列用户已订阅的列表**：订阅集合来自后台（`ListsResponse.subscriptions`），内容脚本不自行判断订阅。举报是「我为什么屏蔽它」，展示未订阅的列表等于让用户替别人做选择。

- 内容脚本渲染原生 DOM，不渲染 Preact 组件（ISOLATED 世界打包后 hooks 上下文会指向另一个实例）；
  `@preact/signals` 的 `signal()` 不依赖 hooks 上下文，可用。
- 内容脚本不经 `shared/mod.ts` 桶文件（会连 zod 与全部字典一起打包），只按相对路径取叶子模块。
- 内容脚本的语言必须在拿到配置之后再设，否则会出现「列表名俄语、按钮中文」。
- `document_start` 时 `document.head` 可能为 null，注入样式用 `document.head ?? document.documentElement`。
- 模拟点击要派发完整事件序列（pointerdown → mousedown → pointerup → mouseup → click）。
- 运行期状态只能通过 `mutateState` 修改；直接读改写会与并发操作互相覆盖。
- `permissions.request` 必须走在用户手势的同步路径上：先拿到 Promise 再 await，中间不能有别的 await。
- 扩展页面的间距必须显式写：`styles.css` 带 Tailwind preflight，`p`/`h1` 的默认边距已被清零。
- Preact 的 SVG 属性必须用连字符写法（`stroke-width`、`clip-path`），camelCase 会被原样写进 DOM；
  lucide 图标的类名走 `className`。
- 字典里加键要防重名：`mergeDicts()` 遇到重复键直接抛错。四列必须齐全，缺列或空串由服务端的测试拦下。
- TypeScript 开了 `noUnusedLocals` / `noUnusedParameters`，它翻出的死代码要清掉。
- 改完扩展产物：清掉 profile 的 `Service Worker` 目录再重启浏览器；不要用 `chrome://extensions`
  的「重新加载」（后台会不再注册）。
- `shared/` 与服务端仓库同源；改契约（类型、常量、字典）时两边一起改。
- 版本号只在 `package.json` 写一次，WXT 取它填清单并用于打包文件名。

## 结构与构建

```
entrypoints/     background、两个内容脚本（x-main / x-isolated）、popup / options / onboarding
src/core/        存储、同步、账号、举报、权限、服务端地址常量
src/x/           选择器、扫描器、过滤引擎、理由弹窗、点击辅助、主题变量
src/ui/          共享组件（列表选择器、标志、图标）与样式
shared/          与服务端同源的契约：类型、API 路径、品牌几何、四语言字典
public/icon/     清单与工具栏图标（PNG）；assets/ 放不参与运行时的标志源文件
docs/screenshots/ README 用的界面截图
```

- `pnpm build` / `build:firefox` / `zip:firefox` / `compile`；产物在 `.output/`。
- 服务端地址只在 `src/core/server.ts` 写一次，清单的 `host_permissions` 由它派生。
- 版本号只在 `package.json` 写一次，WXT 取它填清单并用于打包文件名。
- `shared/` 是本仓库自带的一份客户端契约（按引用裁剪）；改契约时与服务端仓库一起改。

## 关键设计

- **只隐藏，且不改 X 的渲染流程**：命中过滤库的帖子**不设 `display:none`**、也不替换节点，而是把高度收拢到占位信息那一行，再用不透明的绝对定位遮罩盖住内容（原节点留在 DOM 里）。屏蔽与静音仍只在用户自己点「屏蔽」时发生，写请求由 X 发出。
- **防闪**：`document_start` 把「尚未判定」的帖子设为不可见，判定完打上 `decided` 才恢复；看门狗兜底。
- **节点复用**：X 复用时间线的 `<article>`，判定结果写 `data-xlear-tweet` / `data-xlear-identity`。
- **弹窗**：理由弹窗在 shadow root 内渲染原生 DOM，样式取 `themeVariables()` 注入的 X 主题变量；
  确认后恢复 X 的弹窗并代点其确认按钮（见硬性规则 3c）。
- **存储**：配置与密钥在 `storage.local`；过滤库、覆盖、允许列表与举报队列在 IndexedDB。
  备份导出为 JSON（口令加密，PBKDF2 + AES-GCM），也支持 WebDAV 的 `PUT`/`GET`。
- **界面**：弹窗 `min-width: 300px / max-width: 460px`；注入 X 的弹窗 `width: min(320px, calc(100vw - 32px))`。
- **两个名单概念，别混**：服务器列表（`config.subscriptions` 表示勾选，条目在 IndexedDB `filtered`，靠同步拉取）
  与本地列表（`config.localLists`，条目在 `overlay`，只在本机生效，名称与理由交给平台留档）。
  两者的"勾选"含义相同 —— **算不算数**：本地列表的 `enabled` 为假就不再参与匹配、也不出现在屏蔽理由弹窗里，
  但条目原样留着。`ListsResponse.lists` 只放服务器目录，本地列表只在 `local` 里（欢迎页曾把两者混在一起，
  于是本地列表被当成可订阅项）。屏蔽弹窗的名单来源是 `src/x/dialoglists.ts` 这个纯函数：
  已订阅的服务器列表 + 已启用的本地列表。

## X 平台要点

- 帖子 fiber 已含作者数字 ID、screenName、正文与媒体；不解析 GraphQL，也不包装 `fetch`/`XHR`。
- 时间线会复用 `<article>` 节点，属性原地保留，因此必须写身份标记。
- 不依赖页面 computed font，统一用 X 声明的字体栈；不硬编码 GraphQL `queryId`。

## 发版

`pnpm run pack`（= CI 用的同一条流程）产出 zip / xpi / crx / 源码包与 `SHA256SUMS`；
推 `v*` 标签即由 `.github/workflows/release.yml` 建 Release 并挂产物。完整步骤见 `docs/RELEASING.md`。

- **签名私钥永不入库**（`.gitignore` 有 `*.pem`）：一把钥匙对应一个扩展 ID，换钥匙等于换 ID。
  本地在 `~/.local/share/xlear/crx-key.pem`，CI 在仓库 secret `CRX_KEY`，两边都要离线备份。
- 没有私钥时 `pnpm run pack` 会**直接失败**（不生成临时钥匙）—— 这是故意的。
- 产物名与清单版本都来自 `package.json` 的 `version`；发版前先改它，再打 `vX.Y.Z` 标签。
- **分支**：功能与修复走 `dev-<主题>`，main 只在发版时前进；版本号只在维护者明确指示时改
  （硬性规则 7），改完与标签一起走。

## 依赖版本

`wxt@0.21`、`preact@10.29`、`@preact/signals@2.11`、`@preact/preset-vite@2.10`、`tailwindcss@4.3`、
`lucide-preact@1.47`、`idb@8`；构建需要 Node 22+ 与 pnpm。

## 提交

用 `jj` 做版本管理，提交信息用中文，首行概括变更。不要用 `git commit`（`git` 仅用于底层协作）。
开发走 `dev-<主题>` 分支，main 只在发版时前进；版本号只在维护者明确指示时改（见硬性规则）。

## 仓库状态

- 版本 0.3.0，已发布 `v0.2.0`（Release 附 `-chrome.zip`、`.xpi`、`.crx`、`-sources.zip` 与 `SHA256SUMS`）。
  Chrome 与 Firefox 构建通过，`pnpm compile` 干净。
- 测试在服务端仓库（算法与数据层）；本仓库以类型检查与真机构建验证为主。
- 隐藏状态挂在**格子**上（`data-xlear-cell-hidden`，值是账号 ID），不只挂在 `article` 上：X 会反复重建格子内容（广告位实测每 ~83ms 一次），而格子元素本身是复用的，CSS 用 `[data-xlear-cell-hidden] article` 压缩高度即可让新内容自动落进同一条规则。**不要用 `display:none`** —— 把元素从布局里抽走会让 X 的虚拟化更频繁地重建，反而更闪。高度过渡只在格子**首次**被标记时播放（重建出来的节点直接落位，否则每次新建都会重播动画，看上去一直在呼吸）。