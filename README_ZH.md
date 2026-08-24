# LobsterAI OpenTelemetry 插件

将 LobsterAI 的 Agent 生命周期转换为符合 GTrace 语义的 OpenTelemetry Trace 和 Metric，并通过 OTLP/HTTP Protobuf 发送到观测云 GTrace OpenWay 或标准 OTLP 接收端。

## 特性

- 基于 LobsterAI 内置 OpenClaw 的原生生命周期 Hook，不读取聊天数据库、不解析日志。
- 每个终态 run 生成一棵 `invoke_agent -> llm/tool/skill/assistant` Trace 树。
- 仅在明确读取 `SKILL.md` 或产品显式事件时创建 skill span，避免猜测。
- 生成四类标准指标：工作流耗时、操作次数、操作耗时、Token 用量。
- OTLP Protobuf 批次先持久化；Trace 与 Metric 独立确认、精确重试、抑制重复。
- 内容支持 `none`、`preview`、`full`，并递归脱敏 Token、密码、Cookie、私钥等字段。
- 安装后默认不采集，必须显式设置 `enabled=true`。

## 兼容性

已在本机 LobsterAI 2026.8.19（内置 OpenClaw v2026.6.1，commit `2e08f0f`）使用隔离配置目录完成安装与加载验证。Windows 安装器已实现但未在本机验证；详见[产品调研](docs/product-research.md)。

## 安装

推荐在 LobsterAI 的 **设置 > 插件 > 安装 > Git** 中输入：

```text
https://github.com/GuanceCloud/lobsterai-otel-plugin
```

安装后打开 **LobsterAI OpenTelemetry** 配置，填入：

```json
{
  "enabled": true,
  "profile": "gtrace",
  "endpoint": "https://llm-openway.guance.com",
  "xToken": "<workspace-token>",
  "captureContent": "preview"
}
```

然后重启 LobsterAI Gateway。标准 OTLP Collector 请把 `profile` 改为 `otlp`。脚本安装、校验和回滚步骤见[安装文档](docs/installation.md)，完整字段见[配置文档](docs/configuration.md)。

注意：OpenClaw 会阻止未授权的第三方插件读取会话 Hook。Git/UI 安装后还需要设置 `plugins.entries.lobsterai-otel-plugin.hooks.allowConversationAccess=true`；发布安装器会自动完成，并保持 `allowPromptInjection=false`。完整配置见[配置文档](docs/configuration.md)。

## 开发与验收

要求 Node.js 22.19 或更高版本：

```bash
npm ci
npm test
npm run check
npm audit --audit-level=moderate
npm run pack:release
```

所有测试只使用 `test/fixtures` 中的合成数据。架构、Span 树、Metric 与持久化重试契约见[架构文档](docs/architecture.md)，内容边界见[隐私文档](docs/privacy.md)。

## 许可证

Apache License 2.0。
