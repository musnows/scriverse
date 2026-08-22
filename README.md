<p align="center">
  <a href="https://scriverse.top/">
    <img src="./showcase/public/favicon.svg" alt="叙界 Scriverse" width="96">
  </a>
</p>

<h1 align="center">叙界 Scriverse</h1>

<p align="center">
  面向长篇小说创作的本地 AI 工作台
</p>

<p align="center">
  中文 | <a href="README.en.md">English</a>
</p>

<p align="center">
  在线演示：<a href="https://scriverse.top/">https://scriverse.top/</a>
</p>

<p align="center">
  <a href="https://scriverse.top/">
    <img src="./showcase/public/scriverse-overview.png" alt="叙界 Scriverse：让宏大的故事，有迹可循" width="100%">
  </a>
</p>

<p align="center">
  叙界是一个面向长篇小说的本地 AI 创作工作台。它把正文、分卷、角色、组织、世界设定、时间线、人物关系、大纲伏笔和 AI 辅助集中在同一个项目中，适合管理大体量、设定密集的小说工程。
</p>

## 主要能力

- 作品书架：管理多部作品、封面、作者和简介。
- 正文编辑：分卷与章节树、自动保存、历史版本、行号引用、空行整理和全文检索。
- 章节分类：支持正文、设定、作者的话和其他四种类型。
- 文件导入：导入 TXT 或 DOCX，识别分卷、章节和后记类型。
- 设定库：管理世界设定、角色别名、角色属性与锁定字段。
- 组织系统：维护组织简介、设定列表和成员，一个角色可同时属于多个组织。
- 时间线：以看板方式管理多条大事件时间轨道，支持拆分、合并和排序。
- 人物关系：关系类型、关键词列表、证据与置信度，提供普通关系图和可交互的 3D 银河图。
- 大纲与伏笔：维护章节目标、冲突、转折和伏笔的埋设、提醒与回收。
- AI 创作助手：支持 Markdown 和流式输出，可引用章节行、附加角色与设定上下文。
- AI 任务：结构分析、章节分析、角色抽取、时间线分析、关系分析和一致性检查。
- 供应商管理：兼容 OpenAI Chat Completions 与 Anthropic Messages 协议，可配置模型、最大输出 Token、并发数和 RPM。
- 安全导出：支持 JSON、TXT 和 Markdown，导出内容不包含 AI 密钥。

## 技术栈

- Node.js 22.5+
- TypeScript
- Express 5
- Node.js SQLite
- 原生 HTML、CSS 和 JavaScript
- Vitest 与 Supertest

## 快速开始

### 环境要求

- Node.js `>= 22.5.0`
- npm

### 安装与开发运行

```bash
git clone git@github.com:musnows/Scriverse.git
cd Scriverse
npm ci
npm run dev
```

默认访问地址：[http://localhost:13210](http://localhost:13210)

### 生产构建

```bash
npm run build
npm start
```

### Docker 部署

官方镜像为 `musnows/scriverse`，支持 `linux/amd64` 和 `linux/arm64`。完整的 Compose 配置、首次管理员初始化、持久化、升级、备份、日志、健康检查和 HTTPS 反向代理说明见 [Docker 部署指南](docs/docker-deployment.md)。

### 命令行工具

CLI 既可以启动本地 Scriverse，也可以连接任意已运行的服务来查询或编辑作品数据。全局安装后可直接使用 `scriverse` 命令：

```bash
npm install --global @musnows/scriverse
scriverse serve --data-dir ./scriverse-data
```

`serve` 默认监听 `http://127.0.0.1:13210`。启动本地服务不是使用其他 CLI 命令的前置条件；可以保存远程服务作为默认目标：

```bash
scriverse connect https://your-scriverse.example.com
scriverse auth login --api-key-file ./api-key.txt
scriverse work list
```

CLI 会按服务器保存登录凭据。所有连接服务的数据命令都可以使用 `--server <url>` 临时覆盖默认服务器，例如 `scriverse work list --server https://another.example.com`；使用前需先通过 `auth login --server <url>` 登录该服务器。执行 `scriverse connect` 可查看当前默认服务器。

使用 `scriverse --help` 查看本地服务、默认服务器、认证、作品、正文、资源、历史版本和搜索等全部命令。CLI 要求 Node.js `>= 22.5.0`。

## 环境变量

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PORT` | `13210` | HTTP 服务端口 |
| `HOST` | `127.0.0.1` | 监听地址；服务器部署时可设为 `0.0.0.0` |
| `DATA_DIR` | `<项目目录>/.data` | 默认数据目录 |
| `DATABASE_PATH` | `<DATA_DIR>/novel.db` | SQLite 数据库路径 |
| `SCRIVERSE_PRE_MIGRATION_BACKUP_RETENTION` | `5` | 启动迁移备份最多保留的完整版本数；小于 `2` 时按 `2` 处理，启动时清理最旧的超额备份 |
| `SCRIVERSE_STARTUP_RETRY_LIMIT` | `2` | 连续启动失败最多允许的次数；达到上限后停止重复初始化，修复问题并删除 `<DATA_DIR>/.startup-retry.json` 后才能重新启动 |
| `AI_NOVEL_MASTER_KEY` | 自动生成并保存在 `<DATA_DIR>/master.key` | 加密 AI 供应商密钥的主密钥；手动配置时至少 32 个字符 |
| `SCRIVERSE_AI_RETRY_COUNT` | `3` | AI 上游返回除 `403`、`429`、`502` 外的 HTTP 错误时的重试次数；有效整数按 `1`–`20` 钳制 |
| `SCRIVERSE_AI_BACKOFF_RETRY_COUNT` | `10` | AI 上游返回 `429` 或 `502` 时的退避重试次数；有效整数按 `1`–`20` 钳制 |
| `SCRIVERSE_AI_STREAM_IDLE_TIMEOUT_SECONDS` | `30` | 交互式 AI 流等待首个或下一个有效事件的最长空闲秒数；有效整数按 `10`–`120` 钳制，非法值回退为 `30` |
| `APP_AI_CHAT_TAB_LIMIT` | `5` | 浏览器中可同时打开的 Agent 对话数；有效整数按 `1`–`20` 钳制，设为 `1` 时关闭多会话切换和工作台 |
| `APP_AUTH_USERNAME` | 空 | 可选的部署网关账号；应用内用户系统始终启用 |
| `APP_AUTH_PASSWORD` | 空 | 可选的部署网关密码，至少 12 个字符；必须通过 HTTPS 传输 |
| `APP_TRUST_PROXY` | `false` | 位于可信反向代理后时设为代理跳数（通常为 `1`）或 `true` |
| `APP_ALLOW_PRIVATE_AI_ENDPOINTS` | 开发环境 `true`，生产环境 `false` | 默认拦截指向本机或内网的 AI 供应商地址。显式设为 `true`/`1` 后改为允许连接并仅提示风险，启动时会打印警告；链路本地与云元数据地址始终禁止 |
| `APP_ALLOW_REGISTRATION` | `false` | 仅明确设为 `true` 或 `1` 时开放注册；未设置或其他值均关闭，首次初始化创建管理员也必须显式开启 |
| `APP_SETUP_TOKEN` | 空 | 开放注册时必填且至少 32 个字符；仅首位管理员注册需要在页面输入 |
| `SCRIVERSE_AVATAR_IMAGE_MAX_BYTES` | `2097152` | 头像图片上传大小上限，单位为字节 |
| `SCRIVERSE_COVER_IMAGE_MAX_BYTES` | `5242880` | 作品封面图片上传大小上限，单位为字节；封面不支持 GIF |
| `SCRIVERSE_ATTACHMENT_IMAGE_MAX_BYTES` | `31457280` | 设定库等其他图片附件上传大小上限，单位为字节；包括 GIF |
| `SCRIVERSE_AI_CHAT_IMAGE_MAX_BYTES` | `5242880` | 创作助手聊天图片附件上传大小上限，单位为字节；最小可设为 `1048576`（1 MB） |

布尔环境变量统一接受 `true`/`1` 表示开启、`false`/`0` 表示关闭；其他数字不会被解析为布尔值。`APP_TRUST_PROXY` 例外，其 `0`–`10` 数字表示可信代理跳数。

上述三个图片大小限制均使用字节配置；非法、小于 1 或超过 1 GiB 的值会回退到默认值或按 1 GiB 处理。

`APP_ALLOW_PRIVATE_AI_ENDPOINTS` 会削弱 SSRF 防护，只应在必须连接本机或内网模型时显式开启。未设置时生产环境继续拦截这类地址；开启后连接测试不再因此失败，但会弹出提示，服务启动时也会写入警告日志。链路本地地址和云元数据地址即使开启也仍然禁止。

`SCRIVERSE_AI_STREAM_IDLE_TIMEOUT_SECONDS` 在服务启动时读取，只控制交互式 AI 流连续没有新事件的等待时间。每收到一个有效流事件都会重新计时，持续生成超过 60 秒不会因此中断；该配置不设置总时长上限，也不改变分析任务等其他 AI 请求的超时策略。修改后需重启服务生效。

AI 上游 HTTP 重试配置在服务启动时读取。`403` 始终不重试；`429` 和 `502` 使用指数退避，等待从 500 毫秒开始并在 5 秒封顶，同时遵循秒数格式的 `Retry-After`（同样最多等待 5 秒）；其余 HTTP 错误使用线性等待。非法配置回退到对应默认值，修改后需重启服务生效。

自定义示例：

```bash
PORT=13211 DATA_DIR=/path/to/scriverse-data npm run dev
```

服务器部署示例：

```bash
NODE_ENV=production \
HOST=0.0.0.0 \
APP_AUTH_USERNAME=admin \
APP_AUTH_PASSWORD='请替换为足够长的随机密码' \
npm start
```

生产环境必须在可信反向代理后启用 HTTPS。首次初始化时，将 `APP_ALLOW_REGISTRATION` 设为 `true`，并为 `APP_SETUP_TOKEN` 配置至少 32 个字符的随机值；创建的第一个用户会自动成为系统管理员，且必须在页面输入该令牌。完成后应删除这两个环境变量或关闭注册并重启服务。后续添加普通用户只需临时开放注册，不再要求初始化令牌。可选的 HTTP Basic Auth 仅作为额外部署网关，其凭据只是 Base64 编码，未使用 HTTPS 时不能防止链路窃听。`/api/health` 保持免认证以供探活，业务 API 需要应用内登录。

## AI 供应商配置

配置前请先阅读 [AI 供应商兼容性与配置指南](docs/AI-PROVIDER-COMPATIBILITY.md)，其中列出了已验证的服务商、基础地址、模型标识符和已知差异。

1. 启动项目后，点击顶部“AI 管理”进入平台级配置。
2. 新建兼容 OpenAI Chat Completions 或 Anthropic Messages 的供应商，选择协议并填写基础地址、API 密钥、并发数、RPM 与最大输出 Token。
3. 为模型填写其支持的上下文总量（Token），再添加模型。
4. 在平台页设置全局系统提示词；它会追加在内置提示词之后。
5. 打开一本作品，在“更多 → AI 设置”中设置该书的追加系统提示词和任务默认模型；书籍提示词会追加在全局提示词之后。

新建供应商默认最大并发请求数和 RPM 均为 `10`，默认最大输出 Token 为 `32000`；新建模型默认上下文容量为 `128000` Token。侧栏对话框会显示当前请求的上下文用量圆环。

## 数据与安全

- 数据默认保存在 `.data/novel.db`。
- AI 供应商密钥经加密后存储，主密钥默认位于 `.data/master.key`。
- 备份或迁移时，请同时保存数据库和主密钥；丢失主密钥后无法解密已保存的供应商密钥。
- 项目包含应用内多用户系统；首个注册用户自动成为管理员。HTTP Basic Auth 是可选的额外部署网关，不代替应用内登录。
- 服务默认只监听 `127.0.0.1`。非本机监听同样强制要求鉴权，公网入口必须使用 HTTPS、可信反向代理和防火墙访问控制。
- 应用默认启用 CSP、防点击劫持、MIME 嗅探防护、同源写请求校验、认证失败限速、API 限速、JSON/上传大小限制和 AI 供应商 SSRF 防护。
- SQLite 查询通过 prepared statements 绑定参数；动态 SQL 片段只来自服务端受控枚举，不拼接用户输入。

## 测试

```bash
# 类型检查
npm run typecheck

# 全部 Vitest 测试
npm test

# 单元、集成和系统测试
npm run test:unit
npm run test:integration
npm run test:system

# 针对已启动服务的真实 E2E 测试
npm run test:e2e:real

# 类型检查、全部测试和生产构建
npm run check
```

`test:e2e:real` 默认访问 `http://127.0.0.1:13210/api`。如果服务运行在其他地址，可以设置 `E2E_BASE_URL`：

```bash
E2E_BASE_URL=http://127.0.0.1:13211/api npm run test:e2e:real
```

## 项目结构

```text
src/
  ai.ts                  AI 调用、上下文构建与任务编排
  app.ts                 Express API 与静态界面入口
  database.ts            SQLite 表结构与迁移
  parser.ts              TXT/DOCX 小说结构解析
  server.ts              服务启动与关闭
  store.ts               业务数据存取
  public/                浏览器端界面与可视化
tests/
  unit/                  单元测试
  integration/           API 与数据集成测试
  system/                完整作者流程测试
  e2e/                   针对运行服务的端到端测试
```

## 健康检查

```bash
curl http://127.0.0.1:13210/api/health
```

正常响应示例：

```json
{
  "data": {
    "status": "ok",
    "version": "0.3.3",
    "protocol": "openai-chat-completions",
    "protocols": ["openai-chat-completions", "anthropic-messages"]
  }
}
```

## 项目状态

当前为 MVP 版本，接口和数据结构仍可能调整。升级前请备份 `.data` 目录。

## 参与贡献

提交代码或文档前，请阅读 [协作开发规范](docs/CONTRIBUTING.md)。所有日常变更均从最新 `develop` 派生，并通过以 `develop` 为目标分支的 Pull Request 合入。

## 许可证

Copyright (C) 2026 musnows

除另有说明的第三方组件外，本项目自本次许可证变更起采用 [GNU Affero General Public License v3.0 only](LICENSE)（`AGPL-3.0-only`）授权。你可以使用、修改、分发或商业化本软件，但分发衍生版本时必须继续以 AGPLv3 提供对应源码；如果修改后的版本通过网络与用户交互，也必须向这些用户提供该版本的对应源码。

许可证变更前已经发布的版本继续适用其发布时附带的许可证。

## 🌟 Special Thanks

感谢开源项目 [Vditor](https://github.com/Vanessa219/vditor)，为叙界提供 Markdown 编辑器、即时渲染和分屏预览能力。

<p align="center">
  <a href="https://linux.do">
    <img src="showcase/public/linuxdo.png" alt="LINUX DO" width="420" />
  </a>
</p>
<p align="center"><b>学AI，上L站！祝小破站越来越好～</b></p>
