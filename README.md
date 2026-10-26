# LAN Pad Go · 局域网题目协作

`LAN Pad` 的 Go 重写版：保留 React + Tiptap 前端，把 Node/Express/Hocuspocus 后端换成**纯 Go 单进程服务**（[ygo](https://github.com/Deln0r/ygo) + modernc SQLite）。

主机启动服务或双击单个 exe，队友用浏览器打开局域网链接，就能一起编辑**文字 + 代码块 + 截图 + 附件**。运行时不需要 Node，也不需要数据库服务。

![LAN Pad 文档页：文字、代码块和截图](docs/screenshot.png)

---

## 功能

- **免登录、无账号**：链接即房间；队友第一次打开填名字，之后自动记住。
- **实时协作**：Yjs CRDT + y-websocket 协议，Go 服务端维护文档状态；断线重连后自动合并。
- **在线状态**：自定义名字和颜色、在线人数、同步状态、远端光标。
- **富文本编辑**：标题、段落、加粗/斜体/删除线、行内代码、列表、引用、链接、分割线。
- **代码块**：C++ / Python / Java / JavaScript / TypeScript / Rust / Go / SQL / Bash / JSON 等语言选择，语法高亮，一键复制。
- **截图**：`Ctrl/⌘+V` 粘贴、拖拽或选择文件；自动压缩（GIF 除外）、最长边 2560px、单张 ≤10MB；点击图片打开灯箱，`Esc` 关闭。
- **附件**：粘贴、拖拽或工具栏选择，单文件 ≤50MB；ZIP/RAR、PDF、Office、代码、音视频等按类型显示不同图标，支持预览和下载。
- **富文本粘贴**：从网页、Word、WPS、聊天工具直接复制图文混排，图片自动上传；兼容 RTF 剪贴板里的图片。
- **SQLite 持久化**：文档、版本、附件元数据存一个 `data/lanpad.db`；图片/附件存本地；ygo append-only update log，掉电/重启不丢。
- **版本历史**：编辑停顿约 2 秒自动快照（连续编辑最多每 15 秒一份）、内容哈希去重、行级差异对比、一键恢复并支持 `Ctrl+Z` 撤销、单个版本可下载 Markdown。
- **ZIP 导出**：`document.md` + `images/` + `files/`，Markdown 使用相对路径引用图片和附件；浏览器端用 JSZip 打包。
- **服务端只读**：`?mode=view` 由 Go 服务端强制，只读连接发来的文档更新会被丢弃。
- **主机密钥软删除**：首页删除文档需要 `data/host-key.txt`，队友没有密钥不能删除。
- **单文件分发**：`npm run go:build` 产出内嵌前端的 `release/LANPad.exe`（约 12MB），目标机器不需要 Node、npm 或 Go。
- **跨平台**：Windows / macOS / Linux 均可作为主机；纯 Go SQLite，无 CGO。
- **数据兼容**：可以直接打开 Node 版留下的 `data/lanpad.db`。

---

## 快速开始

### 方式一：源码运行

需要 **Go 1.26+** 和 **Node.js ≥ 22.12**（Node 只用于构建前端）：

```bash
npm install
npm run build        # 前端 -> dist/client
npm start            # 等价于 go run ./cmd/lanpad
```

Windows 上也可以直接双击 `start.bat`：缺少前端产物时会自动 `npm install` + `npm run build`，然后启动 Go 服务。

### 方式二：单文件 exe（分发给队友）

```bash
npm install
npm run build        # 先构建前端
npm run go:build     # 内嵌前端并编译 release/LANPad.exe
./release/LANPad.exe
```

把 `release/LANPad.exe` 拷到其他 Windows x64 机器，**双击即可启动**，不需要安装 Node/Go。
macOS / Linux 用同样的命令构建（`scripts/build-go.mjs` 按 `GOOS` 决定产物名，可用 `GOOS`/`GOARCH` 交叉编译）。

启动后控制台会打印：

```text
本机访问:   http://localhost:8787
局域网访问: http://192.168.x.x:8787
主机密钥:   ...
```

把“局域网访问”地址发给队友即可。第一次启动 Windows 防火墙弹窗时，勾选“专用网络”并允许。

---

## 技术栈与架构

| 层 | 选型 |
|---|---|
| 桌面/服务端 | Go 1.26，标准库 `net/http` + 单进程 |
| 实时协作 | [ygo](https://github.com/Deln0r/ygo) v1.29（纯 Go 的 Yjs 端口，y-websocket 协议） |
| 存储 | `modernc.org/sqlite`（纯 Go，无 CGO） |
| 前端 | React 19 + Tiptap 3 + Vite 8 |
| 协作客户端 | `yjs` + `y-websocket` + `@tiptap/y-tiptap` |
| 导出 | JSZip（浏览器端生成 ZIP） |

```text
队友浏览器 ──HTTP（页面/REST/上传）──┐
            ──WebSocket（Yjs/Awareness）─┴─> Go 单进程（ygo + net/http）
                                              ├─> data/lanpad.db（docs/versions/assets/doc_updates）
                                              └─> data/assets/<docId>/（截图/附件）
```

前端构建产物默认从 `dist/client` 读取；打包时被复制到 `internal/web/dist` 并通过 `go:embed` 嵌入二进制。

---

## 目录结构

```text
cmd/lanpad/main.go   Go 入口：配置、监听、端口提示、优雅退出、自动开浏览器
internal/
  config/            环境变量 / .env / 数据目录 / host-key
  docstore/          SQLite：docs / versions / assets / doc_updates
  collab/            ygo 同步服务器、在线人数、只读、最后编辑者
  assets/            图片/附件校验、命名、SHA-256、落盘
  web/               REST API、图片/附件下载、静态前端（含 go:embed）
  network/           局域网 IP 探测
  ids/               文档 ID / 文件名校验
  openbrowser/       跨平台打开浏览器
src/
  App.tsx            路由
  components/        首页、文档页、工具栏、历史、附件卡片、弹窗
  editor/            Tiptap attachment 节点
  api.ts             前端 API
  markdown.ts        Tiptap JSON -> Markdown
  exportDocument.ts  ZIP 打包与下载
  styles.css         全部样式
scripts/             测试脚本、build-go.mjs（单文件打包）、截图脚本
docs/go-rewrite.md   Go 翻写说明（架构、数据兼容、差异）
design.md            原型阶段的设计调研（Node 版时代）
```

---

## 配置

复制 `.env.example` 为 `.env`，按需修改：

```ini
PORT=8787
HOST=0.0.0.0
DATA_DIR=./data
# PUBLIC_BASE_URL=http://192.168.1.23:8787
# HOST_KEY=...
# LANPAD_OPEN=1
```

| 变量 | 默认值 | 说明 |
|---|---|---|
| `PORT` | `8787` | 监听端口 |
| `HOST` | `0.0.0.0` | 监听地址；只允许本机访问可设 `127.0.0.1` |
| `DATA_DIR` | `./data` | SQLite、图片、附件、host-key |
| `PUBLIC_BASE_URL` | 自动探测 | 分享链接使用的外部地址；自动探测的 IP 不对时手动指定 |
| `HOST_KEY` | 自动生成 | 删除文档用的主机密钥；不填则写到 `data/host-key.txt` |
| `LANPAD_OPEN` | `1` | `0` = 启动时不自动打开浏览器 |
| `LANPAD_ROOT` | 当前工作目录 | `.env` 和相对路径的锚点 |
| `CLIENT_DIR` | `./dist/client` | 未内嵌前端时，从磁盘读取前端产物的目录 |

`.env` 从 `LANPAD_ROOT/.env` 读取，已存在的进程环境变量优先。

---

## 使用方式

1. 主机打开首页，点“新建文档”。
2. 点“分享”，复制带本机 IP 的链接，发到群里。
3. 队友打开链接，第一次填名字；之后自动记住。
4. 正文里可以直接：
   - 输入文字，或用工具栏加粗/标题/列表/引用；
   - 点“代码块”，选择 C++ / Python / Java 等语言；
   - `Ctrl/⌘+V` 粘贴截图，或把图片拖进正文；
   - `Ctrl/⌘+V` 粘贴文件，或用“附件”按钮/拖拽，单个文件最大 50MB；
   - 从网页/Word/WPS 复制“文字 + 图片”直接粘贴，图片会自动上传；
   - 点击图片打开灯箱，`Esc` 关闭。
5. 顶部显示在线队友、颜色和同步状态。
6. 点“历史”查看版本快照、对比差异、恢复或下载某个版本。
7. 点“导出”下载 ZIP：`document.md` + `images/` + `files/`，Markdown 里的图片和附件都指向压缩包内的相对路径。

> `?name=红队-01` 可以给固定电脑预填名字；`?mode=view` 是只读查看，由服务端强制只读。

---

## 数据、备份与主机操作

```text
data/
├─ lanpad.db          # SQLite：文档、版本、图片/附件元数据、update log
├─ host-key.txt       # 主机密钥
└─ assets/<docId>/    # 截图和附件文件（按 SHA-256 命名）
```

- 比赛结束后直接复制整个 `data/` 目录归档。
- 恢复：停服务，替换 `data/lanpad.db`，再启动。
- 不要把 `data/` 放在 OneDrive/坚果云等同步目录，SQLite WAL 容易被锁坏。
- 单文件 exe 的数据默认创建在 **exe 同目录的 `data/`**，整个文件夹拷走即可备份/迁移。
- 删除文档（软删除）需要主机密钥：

```bash
curl -X DELETE \
  -H "X-Host-Key: <data/host-key.txt 里的值>" \
  http://127.0.0.1:8787/api/docs/<docId>
```

首页文档卡片右侧也有“删除”按钮：第一次删除会提示输入主机密钥，校验通过后软删除并从列表移除，密钥保存在当前标签页的 `sessionStorage` 里。

---

## Windows 防火墙

首次启动 Windows 可能弹窗，勾选“专用网络”。如果队友打不开，用管理员 PowerShell 执行：

```powershell
New-NetFirewallRule `
  -DisplayName "LAN Pad 8787" `
  -Direction Inbound `
  -Protocol TCP `
  -LocalPort 8787 `
  -Action Allow `
  -Profile Private `
  -RemoteAddress LocalSubnet
```

或：

```bat
netsh advfirewall firewall add rule name="LAN Pad 8787" dir=in action=allow protocol=TCP localport=8787 remoteip=LocalSubnet profile=private
```

如果当前网络被识别为“公用网络”，把网络改为“专用”，或临时把规则改成 `-Profile Any`（确认现场网络可信）。

排查顺序：

1. 两台电脑是否同一网段（`ipconfig` 对比前三位）。
2. 队友能否 `ping 192.168.x.x`。
3. 防火墙是否放行 8787。
4. 是否连了 VPN / 虚拟机网卡，首页选错 IP。
5. 路由器是否开了 AP 隔离/客户端隔离。
6. 公司 Wi-Fi 是否禁止终端互访。

---

## 开发与测试

```bash
npm run dev          # Vite (5173) + Go (8787) 一起启动，/api、/assets、/collab 已代理
npm run typecheck    # 前端类型检查
go test ./...        # Go 单元/集成测试：docstore、assets、HTTP API、版本、静态资源
npm run go:build     # 单文件打包（内嵌前端）
```

浏览器 E2E 脚本需要本机 Chrome 和已启动的服务：

```bash
# 双客户端同步 + awareness + 重连 + 服务端只读
node scripts/test-go-sync.mjs <docId> http://127.0.0.1:8787

# 浏览器端到端
BASE_URL=http://127.0.0.1:8787 node scripts/test-browser.mjs
BASE_URL=http://127.0.0.1:8787 node scripts/test-ui.mjs
BASE_URL=http://127.0.0.1:8787 node scripts/test-online.mjs
BASE_URL=http://127.0.0.1:8787 node scripts/test-reconnect.mjs
BASE_URL=http://127.0.0.1:8787 node scripts/test-clipboard.mjs
BASE_URL=http://127.0.0.1:8787 node scripts/test-mixed-paste.mjs
BASE_URL=http://127.0.0.1:8787 node scripts/test-attachments.mjs
BASE_URL=http://127.0.0.1:8787 node scripts/test-history.mjs
BASE_URL=http://127.0.0.1:8787 node scripts/test-version-cadence.mjs
BASE_URL=http://127.0.0.1:8787 node scripts/test-export.mjs
BASE_URL=http://127.0.0.1:8787 node scripts/test-delete.mjs
```

浏览器脚本默认使用 `C:\Program Files\Google\Chrome\Application\chrome.exe`，可用 `CHROME_PATH` 覆盖；服务地址可用 `BASE_URL` 覆盖。

---

## 主要接口

| 方法 | 路径 | 说明 |
|---|---|---|
| `GET` | `/api/health` | 健康检查 |
| `GET` | `/api/network` | 本机局域网地址 |
| `GET` | `/api/docs` | 文档列表（可带 `?base=`） |
| `POST` | `/api/docs` | 新建文档 |
| `GET` | `/api/docs/:id` | 文档元数据 |
| `DELETE` | `/api/docs/:id` | 软删除（需 `X-Host-Key`） |
| `POST` | `/api/docs/:id/assets` | 上传截图（≤15MB，PNG/JPEG/GIF/WebP） |
| `POST` | `/api/docs/:id/attachments` | 上传附件（≤50MB，任意类型） |
| `GET` | `/api/docs/:id/versions` | 版本历史列表 |
| `POST` | `/api/docs/:id/versions` | 立即保存快照 |
| `GET` | `/api/docs/:id/versions/:versionId` | 版本详情（含 base64 Yjs state） |
| `GET` | `/assets/:docId/:filename` | 读取截图/附件 |
| `WS` | `/collab/:docId` | Yjs + awareness 同步 |

---

## 与 Node 版的差异

1. **前端 provider 改为 y-websocket**：Hocuspocus v4 的帧格式与 ygo 不兼容，前端已改成 `y-websocket`。
2. **删除文档不会踢掉已连接的人**：ygo 没有按文档关闭连接的公开 API；已连接客户端仍可编辑，但文档会从列表消失，新连接被拒绝。
3. **`last_editor` 是近似值**：来自最近连接（且非只读）的用户名，不是精确的“最后写入者”。
4. **没有 Origin 校验**：与 Node v0.1 一致，适合可信局域网；公网部署需要补。

---

## 已知限制（v0.1）

- 无账号体系；拿到链接的人都能编辑。适合可信的队内局域网。
- 没有离线 IndexedDB 缓存；页面刷新需要服务在线。
- 图片 ≤10MB（宽度 ≤2560）；附件 ≤50MB；文本建议 <5MB。
- 附件预览依赖浏览器：PDF/文本可直接打开，压缩包和 Office 文件按下载处理。
- 复杂 Word 表格/样式会做简化，正文和图片会保留；表格/公式可后续补。
- 部分 WPS/Word 版本只在 HTML 里放本地 `file://` 图片路径，程序会尝试从 RTF 剪贴板提取图片；如果源程序只提供浏览器无法解码的 EMF，仍会提示单独截图。
- 还没有独立的“导出为 PDF/Word”功能；需要时可以先导出 Markdown 再转换。

---

## 更多文档

- [docs/go-rewrite.md](docs/go-rewrite.md)：Go 重写的模块对照、数据兼容、快照策略、实时同步细节。
- [design.md](design.md)：原型阶段的需求、选型与产品设计调研（当时后端是 Node）。
- Node 原版实现与历史提交：[Fzuim/lan-pad](https://github.com/Fzuim/lan-pad)。
