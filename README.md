# dsh-llm-grok

DeepSeek Harness 插件：把 **Grok 订阅额度** 接成 DSH 的 LLM 提供方。

- GitHub：https://github.com/clarkzhao/dsh-llm-grok
- npm：`dsh-llm-grok`
- topic：`dsh-plugin`

Grok 4.6 / 4.5 在本插件里是原生多模态：用户贴图和 tool-result 里的图会随同一次 `/chat/completions` 发给订阅端点。图不是先 OCR 成字再交给文本模型，也不会多出一个识图工具。

## 能力

| | grok-4.6 | grok-4.5 |
|---|---|---|
| 思考强度 | low / medium / high / xhigh | low / medium / high |
| 上下文 / 输出 | 500K / 128K | 同左 |
| 输入模态 | text + image | text + image |

- 默认 `baseURL`：`https://cli-chat-proxy.grok.com/v1`
- 走本机 HTTP 代理（默认 Clash `http://127.0.0.1:7890`），不依赖 Python 旁路
- 会话日志只存附件引用（`sha256:`）。像素只在发请求时从 `ctx.attachments` 读出，编成 `image_url` data URL
- 缺附件服务、或图出现在 system / assistant 消息里：`UNSUPPORTED_CONTENT`

## 安装

```bash
dsh plugin --profile web add dsh-llm-grok
# 未全局安装 dsh 时：
npx @deepseek-ai/dsh plugin --profile web add dsh-llm-grok
```

其他来源：`github:clarkzhao/dsh-llm-grok`，或在仓库目录执行 `dsh plugin --profile web add .`。把 `web` 换成你的 profile 名即可。

安装后 bundle 会写入 `llm-grok` 并注册 `grok` provider。若曾在 `llm-pi-ai` 里加过同名 `grok`，先删掉，避免路由冲突。

## 凭据

插件**不读** `~/.grok/auth.json`，也**不会自动续期**。它只解析 DSH 凭据引用 `GROK_SESSION_TOKEN`。Grok CLI 的 access token 约 6 小时过期；CLI 自己会续 `auth.json`，必须再同步进 DSH，否则下一发请求 401。

完整步骤（一次性写入、launchd / cron 自动挂载、env 遮挡、LaunchAgents 写不进去、6 小时边界）：**[docs/credential-sync.md](docs/credential-sync.md)**。

最短路径：

```bash
grok login                                          # token 落到 ~/.grok/auth.json
python3 scripts/sync-grok-credential.py             # 写入 ~/.dsh/.credentials.yaml
# macOS 每 5 分钟自动同步（推荐）：
chmod +x scripts/install-launchd.sh
./scripts/install-launchd.sh
```

现行 DSH 凭据文档是 version-1，同步脚本会写成：

```yaml
version: 1
refs:
  GROK_SESSION_TOKEN: <token>
```

**不要**在已有 `version: 1` 的文件顶层再写扁平的 `GROK_SESSION_TOKEN:`（`unknown top-level key`，`dsh web` 可能起不来）。

也可以启动 DSH **之前**设置环境变量 `GROK_SESSION_TOKEN`（不要把值写进文档或聊天）。进程环境优先级高于文件：若 dsh 启动时环境里已有该变量，文件同步**改不掉**正在使用的值，需 `unset GROK_SESSION_TOKEN` 后重启 DSH。详见文档 §2。验证时只确认 key 是否存在，不要 `cat` / `grep` 凭据文件。

未配置时请求会失败：`dsh-llm-grok: missing credential GROK_SESSION_TOKEN`。

发往订阅端点时使用：

```text
Authorization: Bearer <token>
X-XAI-Token-Auth: xai-grok-cli
x-authenticateresponse: authenticate-response
x-grok-client-version: 1.0.4
x-grok-model-override: grok-4.6 | grok-4.5
```

后端据此按 **订阅用户** 计费，而不是普通 API Key。

## 配置

默认在插件的 `cordis.patch.yml`。可在 profile 或 home 层覆盖：

```yaml
- id: llm-grok
  name: dsh-llm-grok
  config:
    baseURL: https://cli-chat-proxy.grok.com/v1
    apiKeyEnv: GROK_SESSION_TOKEN
    proxy: http://127.0.0.1:7890
    models:
      - id: grok-4.6
        name: Grok 4.6
        contextWindow: 500000
        maxTokens: 128000
        reasoningEfforts:
          low: low
          medium: medium
          high: high
          xhigh: xhigh
      - id: grok-4.5
        name: Grok 4.5
        contextWindow: 500000
        maxTokens: 128000
        reasoningEfforts:
          low: low
          medium: medium
          high: high
```

## 开发

```bash
npm install
npm test
npm run build
```

```text
dsh-llm-grok/
├── package.json
├── cordis.patch.yml
├── docs/
│   └── credential-sync.md   # 自动把 grok CLI token 挂进 DSH
├── scripts/
│   ├── sync-grok-credential.py
│   └── install-launchd.sh
├── src/
│   ├── index.ts       # 注册 grok provider，注入凭据与附件读取
│   ├── adapter.ts     # LlmAdapter：chat-completions + 模态声明
│   ├── serialize.ts   # DSH 消息 → 文本 / image_url / 工具
│   ├── translate.ts   # SSE → DSH StreamChunk
│   └── types.ts
└── tests/
    ├── serialize.test.ts
    └── sync-grok-credential.test.py
```

## 限制

- 只走 chat-completions，不实现官方 CLI 默认的 Responses API
- 不做大图请求体驱逐（grok-build 约 50MB 那套策略尚未搬过来）
- Trajectory 不会出现单独的「识图」tool 行：图在 adapter 组请求时编进 user / tool 消息
- 不读 `~/.grok/auth.json`，不做 `refresh_token` 惰性刷新（方案 B 未实施）。自动挂载是仓库外的 launchd / cron 同步，见 [docs/credential-sync.md](docs/credential-sync.md)
