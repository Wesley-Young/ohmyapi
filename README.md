# ohmyapi

简化的多用户 AI API 计费网关，支持管理员创建用户、手动调账、条件定价和 JSON/SSE 直通转发：`/v1/chat/completions`、`/v1/responses`、`/v1/messages`。

后端使用 Hono、tRPC、Drizzle 和 PostgreSQL；前端使用 React、Chakra UI 和 TanStack Query。

## 启动

需要 Node.js 24.13+、pnpm v12、PostgreSQL 17；本地数据库和 e2e 测试需要 Docker。

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

按 [.env.example](.env.example) 生成并保存稳定的 `CHANNEL_ENCRYPTION_KEY`，设置 `GATEWAY_ENABLED=true` 后重启。后台配置渠道、可用模型、模型价格及倍率，为用户授权模型并入账；用户创建 API Key 时绑定渠道。

开启网关即启用预占和实际扣费。当前支持文本与自定义函数工具；调用必须提供输出上限：Chat 的 `max_completion_tokens` 或 `max_tokens`、Responses 的 `max_output_tokens`（至少 16）、Messages 的 `max_tokens`，均不得超过模型配置。模型输入容量同时限制 JSON 正文字节数。

生产部署采用单实例，将前端、`/api` 和 `/v1` 放在同一 origin 下，设置 `APP_ORIGIN` 和安全 Cookie，并关闭 SSE 代理缓冲。

## 常用命令

```sh
pnpm build        # 构建前后端
pnpm start        # 启动已构建的后端
pnpm typecheck    # 类型检查
pnpm lint         # Biome 检查
pnpm format       # 格式化
pnpm db:generate  # 生成数据库迁移
pnpm test:e2e     # 临时数据库中的完整流程验证
```
