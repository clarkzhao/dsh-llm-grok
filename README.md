# dsh-llm-grok

独立 DeepSeek Harness 插件骨架：把 Grok 订阅额度接入 DSH 的 LLM 提供方。

当前形态是 **独立 repo / bundle 插件**，不需要修改 DSH 源码。它通过 DSH 的
`dsh plugin` 机制安装到 profile，并注册 `grok` provider。

## 特性

- 支持 `grok-4.6`、`grok-4.5`
- 支持思考强度：
  - `grok-4.6`: `low / medium / high / xhigh`
  - `grok-4.5`: `low / medium / high`
- 复用当前已验证的本地代理方案：
  - `scripts/grok_dsh_proxy.py` 负责走 `7890` 代理并注入 Grok 订阅所需 headers
  - 插件默认 `baseURL` 指向 `http://127.0.0.1:8765/v1`

## 目录结构

```text
dsh-llm-grok/
├── package.json           # 声明 dsh.bundle，可被 dsh plugin 安装
├── cordis.patch.yml       # 插入 llm-grok 插件行
├── tsconfig.json
├── src/
│   ├── index.ts           # Cordis 插件入口，注册 grok provider
│   ├── adapter.ts         # GrokAdapter（LlmAdapter 实现）
│   ├── serialize.ts       # DSH 消息 → OpenAI chat-completions 请求
│   ├── translate.ts       # SSE → DSH StreamChunk
│   └── types.ts           # wire 类型
└── scripts/
    └── grok_dsh_proxy.py  # 本地 Grok 订阅代理（沿用当前方案）
```

## 开发

```bash
npm install
npm run build
```

## 安装到 DSH

先启动本地代理：

```bash
cd dsh-llm-grok
python3 scripts/grok_dsh_proxy.py --port 8765
```

然后在包含本 repo 的目录执行：

```bash
dsh plugin --profile web add ./dsh-llm-grok
```

或者使用其他 profile：

```bash
dsh plugin --profile myprofile add ./dsh-llm-grok
```

安装后 DSH 会自动把 `cordis.patch.yml` 作为 bundle layer 应用，新增
`llm-grok` 插件行并注册 `grok` provider。

> 注意：如果你之前通过 `llm-pi-ai` settings 添加过名为 `grok` 的 provider，
> 需要先移除，避免 provider route 冲突。

## 配置

插件默认配置在 `cordis.patch.yml` 中，也可以在 profile 的
`cordis.patch.yml` 或 home 层覆盖：

```yaml
- id: llm-grok
  name: dsh-llm-grok
  config:
    baseURL: http://127.0.0.1:8765/v1
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

## TODO / 后续

- [ ] 在 `GrokAdapter` 中直接支持 `https://cli-chat-proxy.grok.com/v1`
      并通过 Node proxy agent（例如 `undici` 的 `ProxyAgent`）走 `7890`，
      从而不再依赖外部 Python 代理进程。
- [ ] 补测试：SSE 解析、消息序列化、配置校验。
- [ ] 发布到 npm，支持 `dsh plugin add dsh-llm-grok`。
