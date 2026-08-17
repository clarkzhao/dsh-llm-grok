# dsh-llm-grok

独立 DeepSeek Harness 插件：把 Grok 订阅额度接入 DSH 的 LLM 提供方。

已发布：

- GitHub：https://github.com/clarkzhao/dsh-llm-grok
- npm：`dsh-llm-grok@0.1.0`
- GitHub topic：`dsh-plugin`（便于 DSH 插件市场发现）

## 特性

- 支持模型：
  - `grok-4.6`
  - `grok-4.5`
- 支持思考强度：
  - `grok-4.6`: `low / medium / high / xhigh`
  - `grok-4.5`: `low / medium / high`
- 直接连接 Grok 订阅端点，不依赖本地 Python 代理：
  - 默认 `baseURL`：`https://cli-chat-proxy.grok.com/v1`
  - 通过 `undici` `ProxyAgent` 走你的 Clash `7890` 代理

## 安装到 DSH

### 从 npm 安装（推荐）

```bash
dsh plugin --profile web add dsh-llm-grok
```

其他 profile：

```bash
dsh plugin --profile myprofile add dsh-llm-grok
```

### 从 GitHub 安装

```bash
dsh plugin --profile web add github:clarkzhao/dsh-llm-grok
```

### 从本地源码安装

```bash
cd /path/to/dsh-llm-grok
dsh plugin --profile web add .
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
npm run build
```

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
```

## TODO / 后续

- [ ] 补测试：SSE 解析、消息序列化、配置校验。
