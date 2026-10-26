# Go 版本翻写说明

本仓库是 LAN Pad 的 Go 重写版：保留 React + Tiptap 前端，把 Node/Express/Hocuspocus
后端换成纯 Go 单进程服务，最终得到一个不依赖 Node 运行时的单文件程序。

当前状态：**后端功能已跑通**，可以完整替代 Node 服务；前端只改了实时同步的 provider。

---

## 为什么不是“把 Express 换成 Gin”这么简单

真正的难点是实时协作。前端用的是 Yjs，服务端必须能读懂 Yjs 的二进制 update、state vector
和 awareness，并维护每个文档的 CRDT 状态。自己实现一遍 Yjs 协议风险很高，所以选用了：

- [ygo](https://github.com/Deln0r/ygo) `v1.29.0`：纯 Go 的 Yjs 端口，V1/V2 线格式与
  `yjs@13.6.33` 双向兼容，自带 Hocuspocus/y-websocket 同步服务器、SQLite 持久化接口；
- `modernc.org/sqlite`：纯 Go SQLite，无 CGO，交叉编译和单文件分发都简单。

### 一个关键取舍：前端改用 y-websocket

Hocuspocus v4 客户端在每一帧前面写 `documentName`，而 ygo 的帧格式是
`[messageType][payload]`（y-websocket 协议）。两者并不兼容，这一点与部分宣传文案不符。
因此前端把 `@hocuspocus/provider` 换成了 `y-websocket`：

- `WebsocketProvider(url, docId, ydoc, { params: { user, mode } })`；
- URL 变成 `/collab/<docId>`，ygo 用路径最后一段作为文档名；
- awareness 从 `provider.setAwarenessField` 改为 `provider.awareness.setLocalStateField`；
- 状态/同步事件从 `onStatus/onSynced` 改为 `status`/`sync` 事件。

Tiptap 的协作扩展只依赖 `provider.awareness`，所以编辑器代码不需要改。

---

## 目录结构

```text
cmd/lanpad/main.go            启动、端口占用提示、优雅退出、自动开浏览器
internal/config/              .env / 环境变量 / 数据目录 / host-key
internal/docstore/            SQLite：docs、versions、assets、doc_updates
internal/collab/              ygo 同步服务器、在线人数、只读、最后编辑者
internal/assets/              图片嗅探、附件类型/文件名、SHA-256、去重落盘
internal/network/             局域网 IPv4 探测与排序
internal/web/                 REST API、图片、静态前端、安全响应头
internal/ids/                 文档 ID / 图片文件名校验
internal/openbrowser/         跨平台打开浏览器
scripts/test-go-sync.mjs      Go 服务端的双客户端同步/重连/只读测试
scripts/test-attachments.mjs  附件粘贴/图标/同步/下载测试
scripts/build-go.mjs          内嵌前端并编译单文件二进制
```

前端仍是 `src/`，构建产物是 `dist/client/`。开发时 Go 从磁盘读取；打包时
`scripts/build-go.mjs` 会把它复制到 `internal/web/dist` 并用 `go:embed` 打进二进制。

---

## 运行

```bash
# 1. 构建前端（改动前端后需要重新执行）
npm install
npm run build

# 2. 直接跑 Go 后端（从 dist/client 读前端）
npm start            # 等价于 go run ./cmd/lanpad

# 3. 或者编译单文件 exe（内嵌前端，不需要 dist/client）
npm run go:build     # release/LANPad.exe
./release/LANPad.exe
```

默认地址 <http://localhost:8787>，与 Node 版本一致。数据仍在 `./data/`。

`npm run dev` 同时启动 Vite 和 Go（`concurrently`）。Node 版 `server/` 与 SEA 打包脚本不在本仓库，
需要时去 [lan-pad](https://github.com/Fzuim/lan-pad) 查看。

### 单文件构建

`npm run go:build` 会：

1. 检查 `dist/client/index.html`；
2. 复制到 `internal/web/dist`；
3. 用 `-tags embedclient` 编译，把前端通过 `go:embed` 打进二进制；
4. 输出 `release/LANPad.exe`（约 12 MB）。

不带 `embedclient` 标签的 `go run` / `go build` 仍然从 `CLIENT_DIR`（默认
`./dist/client`）读取前端，方便改前端时热更新。

### 环境变量

与 Node 版本相同，另加两个 Go 侧变量：

| 变量 | 默认值 | 说明 |
|---|---|---|
| `PORT` | `8787` | 监听端口 |
| `HOST` | `0.0.0.0` | 监听地址 |
| `DATA_DIR` | `./data` | SQLite、图片、host-key |
| `PUBLIC_BASE_URL` | 自动探测 | 分享链接使用的外部地址 |
| `HOST_KEY` | 自动生成 | 删除文档用的主机密钥 |
| `LANPAD_OPEN` | `1` | `0` = 启动时不打开浏览器 |
| `LANPAD_ROOT` | 当前工作目录 | `.env` 和相对路径的锚点 |
| `CLIENT_DIR` | `./dist/client` | 前端构建产物目录 |

`.env` 会从 `LANPAD_ROOT/.env` 读取，已存在的进程环境变量优先。

### npm 快捷命令

```bash
npm run go:run     # go run ./cmd/lanpad
npm run go:build   # 编译 release/LANPad.exe（内嵌前端）
npm run go:test    # go test ./...
```

---

## 数据兼容

Go 版直接复用 Node 版的数据库结构，`data/lanpad.db` 可以双向打开：

- `docs.state` 仍然保存完整的 Yjs V1 update，Node 版可以直接读；
- 新增 `doc_updates` 表，作为 ygo 的 append-only update log；启动时会把只有
  `docs.state` 的旧文档自动补一条 log；
- `versions` 增加了 `sha256` 列；旧数据库启动时自动补列并回填哈希。快照策略：新建文档时存一份，
  编辑**停顿约 2 秒**后存一份；如果一直连续输入没有停顿，最多每 15 秒存一份；最后一个人离开时再补一份。
  哈希按“标题 + 正文/格式”计算，内容没变不会重复记录，每个文档最多保留 50 份；
- `assets` 增加了 `name`（原始文件名）和 `kind`（`image` / `file`）列；旧数据库自动补列；
- `settings`、`host-key.txt` 不变。

单次编辑先同步写 log（掉电不丢），标题/`updated_at`/`docs.state` 由 800ms 防抖的
后台任务刷新；服务退出时强制落盘。每 200 条 update 会触发一次 log 压缩，避免长时间
协作把日志撑大。

---

## REST API

与 Node 版保持一致：

| 方法 | 路径 | 说明 |
|---|---|---|
| `GET` | `/api/health` | 健康检查 |
| `GET` | `/api/network` | 局域网地址 |
| `GET` | `/api/docs` | 文档列表（可带 `?base=`） |
| `POST` | `/api/docs` | 新建文档 |
| `GET` | `/api/docs/:id` | 文档元数据 |
| `DELETE` | `/api/docs/:id` | 软删除，需 `X-Host-Key` |
| `GET` | `/api/docs/:id/versions` | 版本列表（新的在前） |
| `POST` | `/api/docs/:id/versions` | 立即保存一份快照 |
| `GET` | `/api/docs/:id/versions/:versionId` | 版本详情（含 base64 Yjs state） |
| `POST` | `/api/docs/:id/assets` | 上传图片（≤15MB） |
| `POST` | `/api/docs/:id/attachments` | 上传附件（≤50MB，任意类型） |
| `GET` | `/assets/:docId/:filename` | 读取图片/附件 |
| `WS` | `/collab/:docId` | Yjs + Awareness |

`POST /api/docs/:id/assets` 仍然限制 15 MB、只接受 PNG/JPEG/GIF/WebP，按 SHA-256 去重。
`POST /api/docs/:id/attachments` 接受任意文件（最大 50 MB），原始文件名保存在 `assets.name`，
下载时通过 `Content-Disposition` 还原；压缩包、Office、SVG/HTML 等不会以内联方式打开。

---

## 附件

- 前端自定义了 Tiptap 的 `attachment` 原子 block 节点，attrs 里只存 `url/name/size/mime/ext`，
  所以附件和图片一样通过 Yjs 同步；
- 粘贴文件、拖拽文件、工具栏“附件”选择都会走 `POST /attachments`；图片仍走原来的图片压缩/上传链路；
- 卡片按扩展名/MIME 显示不同颜色和标签（RAR/ZIP、PDF、DOC、XLS、PPT、代码、音视频等），
  带“预览/打开”和“下载”按钮；
- 客户端和服务端都限制 50 MB；图片仍限制 10/15 MB。

---

## 版本历史

文档页标题栏的“历史”按钮会打开版本面板：

- 按时间倒序显示快照卡片（相对时间、内容哈希、state 大小）；编辑停顿约 2 秒后采样一次，
  连续编辑最多每 15 秒一次，所以“A 输入 123456、B 紧接着删掉 6”会留下 123456 和 12345 两个可对比版本，
  又不会每敲几个字就产生一张卡片；
- 内容哈希按“标题 + ProseMirror XML（含格式属性）”计算，仅 CRDT 元数据不同、可见内容相同的状态不会重复记录；
- 选中快照后，把它的 Yjs state 解码成 ProseMirror JSON，再转成纯文本与当前正文做行级 LCS diff：
  红色 `-` 是恢复会删掉的行，绿色 `+` 是当前独有的行；
- 可把某个版本下载成 Markdown 文本；
- **恢复由前端完成**：`editor.commands.setContent(...)` 产生一次普通的本地编辑，经 Yjs 同步给所有
  在线队友，因此对所有人生效，并且可以被 `Ctrl+Z` 撤销。Go 端不需要也不能直接“替换”在线文档；
- 恢复前会调用 `POST /versions` 把当前状态存一份，避免恢复后找不到恢复前的内容；
- 只读连接可以查看和下载历史，但恢复按钮禁用；
- 旧文档第一次打开历史时，如果没有快照，会自动补一份当前状态的基线。

---

## 导出

标题栏的“导出”按钮会把**当前文档**打成 ZIP 下载：

```text
导出测试文档.zip
├─ document.md
├─ images/<sha256>.png
└─ files/BaoGuaWindowsEvent.rar
```

- Markdown 由当前 Tiptap JSON 在前端生成，支持标题、段落、加粗/斜体/删除线/行内代码、
  链接、代码块、列表、引用、分割线、图片和附件；
- 图片写成 `![alt](images/<sha>.png)`，附件写成 `[原始文件名](files/...)`，路径相对 ZIP 根目录；
- 导出时逐个 `fetch` 文档里引用到的本地 `/assets/...` 文件并放进 ZIP，图片和附件都真正随包下载；
- 外部 `http(s)` 图片不做下载，Markdown 里保留原始 URL；
- 文件按内容 SHA-256 去重；同名附件会自动加短哈希后缀，避免覆盖；
- 导出只包含当前文档，不含版本历史；导出过程中按钮显示进度，失败会提示具体哪个文件下载失败；
- 压缩包用 JSZip 在浏览器端生成，不需要额外后端接口。

---

## 实时同步与在线状态

- ygo 负责 Sync Step1/2、增量 update、QueryAwareness、awareness 广播；
- 在线人数由 `OnConnect`/`OnDisconnect` 自己维护，与 Node 版的 socket 计数一致；
- `?mode=view` 现在由服务端强制：该连接发来的文档 update 会被直接丢弃，比 Node 版
  只在前端 `contenteditable=false` 更安全；
- `?user=名字` 作为“最后编辑者”的近似来源（Node 版取 awareness 里的名字，同样不是
  严格意义的上一个编辑者）；
- 文档不存在、ID 非法时 WebSocket 会被拒绝，不会像 Node 版那样产生空文档。

---

## 与 Node 版的已知差异

1. **前端 provider 改为 y-websocket**，不再是 Hocuspocus 协议。
2. **删除文档不会踢掉已连接的人**：ygo 没有按文档关闭连接的公开 API；已连接客户端
   仍可编辑，但文档会从列表消失，新连接会被拒绝。后续可以在 Manager 里记录连接并在
   删除时统一关闭。
3. **`last_editor` 是近似值**：来自最近连接（且非只读）的用户名，不是精确的“最后写入者”。
4. **没有 Origin 校验**：与 Node v0.1 一致，适合可信局域网；公网部署需要补。

---

## 验证

```bash
# Go 单元/集成测试：docstore、assets、HTTP API、版本、静态资源
go test ./...

# 双客户端同步 + awareness + 重连 + 服务端只读
node scripts/test-go-sync.mjs <docId> http://127.0.0.1:8787

# 浏览器端到端（需要已启动 Go 服务和本机 Chrome）
BASE_URL=http://127.0.0.1:8787 node scripts/test-browser.mjs
BASE_URL=http://127.0.0.1:8787 node scripts/test-ui.mjs
BASE_URL=http://127.0.0.1:8787 node scripts/test-online.mjs
BASE_URL=http://127.0.0.1:8787 node scripts/test-history.mjs
BASE_URL=http://127.0.0.1:8787 node scripts/test-version-cadence.mjs
BASE_URL=http://127.0.0.1:8787 node scripts/test-attachments.mjs
BASE_URL=http://127.0.0.1:8787 node scripts/test-export.mjs
```

已实测通过：中文标题/正文、代码块、图片上传与同步、灯箱、在线人数、断线重连、
`?mode=view` 服务端只读、版本差异/恢复/Ctrl+Z 撤销，以及从旧 Node 数据库启动。

---

## 下一步

1. 删除文档时关闭该文档的在线连接；
2. 把 `last_editor` 换成基于 awareness 的精确记录（需要在 ygo 连接层旁路解析 awareness）；
3. 增加访问码/签名只读链接（设计文档里的 v0.2 内容）；
