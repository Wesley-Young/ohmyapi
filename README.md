# ohmyapi

简化的多用户 AI API 计费网关，支持管理员创建用户、手动调账、条件定价和 JSON/SSE 直通转发：`/v1/chat/completions`、`/v1/responses`、`/v1/messages`。

后端使用 Hono、tRPC、Drizzle 和 PostgreSQL；前端使用 React、Chakra UI 和 TanStack Query。

## 启动

需要 Node.js 24.13+、pnpm v12、PostgreSQL 17；使用内置本地数据库需要 Docker。

```sh
pnpm install
cp .env.example .env
```

编辑 `.env`，设置数据库连接、管理员用户名和至少 8 字符的初始密码。币种默认 USD，也可在首次初始化时选择 CNY，之后固定。

```sh
pnpm db:up       # 已有 PostgreSQL 时跳过
pnpm db:migrate
pnpm db:init
pnpm dev
```

初始化后移除 `.env` 中的 `BOOTSTRAP_ADMIN_USERNAME` 和 `BOOTSTRAP_ADMIN_PASSWORD`。初始迁移面向全新数据库。

## 网关

按 [.env.example](.env.example) 生成并保存稳定的 `CHANNEL_ENCRYPTION_KEY`，设置 `GATEWAY_ENABLED=true` 后重启。后台配置渠道支持的端点及可用模型、模型价格及倍率，为用户授权模型并入账；用户创建 API Key 时绑定渠道。

开启网关即启用预占和实际扣费。当前支持文本与自定义函数工具；调用必须提供输出上限：Chat 的 `max_completion_tokens` 或 `max_tokens`、Responses 的 `max_output_tokens`（至少 16）、Messages 的 `max_tokens`，均不得超过模型配置。模型输入容量同时限制 JSON 正文字节数。模型的所有端点共用一套价格规则，保存后立即生效；在途请求按开始时保存的价格快照结算。

冻结金额按请求内容估算输入，按该用户、渠道、模型和端点最近 100 次已结算请求的输出 P95 估算输出。输入及有历史依据的输出增加 25% 和 256 Token 余量；历史少于 5 次时输出采用 4096 Token，有历史时至少 512 Token，且不超过调用方输出上限。最终按上游用量扣费，费用可以超过冻结额；欠费后不能继续发起请求。

生产部署采用单实例，将前端、`/api` 和 `/v1` 放在同一 origin 下，设置 `APP_ORIGIN` 和安全 Cookie，并关闭 SSE 代理缓冲。

## 常用命令

```sh
pnpm build        # 构建前后端
pnpm start        # 启动已构建的后端
pnpm typecheck    # 类型检查
pnpm lint         # Biome 检查
pnpm format       # 格式化
pnpm db:generate  # 生成数据库迁移
```
