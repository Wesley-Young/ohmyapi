# ohmyapi

Simple AI API Gateway

## 本地初始化

需要 Node.js 24.13+、pnpm v12，以及 PostgreSQL 17（可通过 Docker Compose 启动）。

```sh
pnpm install
cp .env.example .env
```

编辑 `.env`：设置 `DATABASE_URL`、`BOOTSTRAP_ADMIN_USERNAME` 和至少 12 字符的 `BOOTSTRAP_ADMIN_PASSWORD`。计价币种默认 USD，也可在首次初始化前设置为 CNY；初始化后固定。

```sh
pnpm db:up       # 可选：启动本地 PostgreSQL，已有数据库时跳过
pnpm db:migrate  # 显式执行迁移，可重复执行
pnpm db:init     # 原子初始化管理员、零余额钱包和系统计费约定
pnpm dev
```

初始化后从 `.env` 移除 `BOOTSTRAP_ADMIN_USERNAME` 和 `BOOTSTRAP_ADMIN_PASSWORD`。再次运行初始化不会重置密码或新增管理员。登录后直接进入控制台，无强制改密。

管理员可在“用户”页面创建账户：密码留空时默认随机生成 16 字符密码，并在创建成功时一次性显示。用户可自行修改密码。控制台还支持 Key 创建/撤销、余额与流水查询，以及管理员启停用户、重置密码、撤销会话和手动调账。

升级已有数据库后先执行 `pnpm db:migrate`；第三批迁移将旧渠道路由合并为可用模型列表，增加渠道倍率及 Key 固定渠道；旧 Key 需由所属用户手动绑定渠道。价格配置与迁移说明见 [docs/pricing.md](docs/pricing.md)。第四批增加模型输入/输出上限、预占、结算及恢复；历史请求不会追溯扣费。升级后重启服务，按 [docs/billing.md](docs/billing.md) 核对模型容量与调用参数。

生产环境请设置 `APP_ORIGIN` 为浏览器访问的完整 origin（如 `https://api.example.com`），并启用 `SESSION_COOKIE_SECURE=true`。Cookie 使用 HttpOnly、SameSite=Strict，生产 Secure Cookie 使用 `__Host-` 前缀。前端、`/api` 和 `/v1` 应通过同一 origin 提供服务，反向代理将 `/api`、`/v1` 转发到 daemon（SSE 关闭缓冲），其余路径提供前端并回退到 `index.html`。

`/api/health` 是进程存活检查，`/api/ready` 检查数据库连接及计费所有权。服务启动时校验迁移、初始化状态和币种；不会自动迁移或创建管理员。

本地 Compose 默认密码仅用于开发；修改 `POSTGRES_PASSWORD` 或 `POSTGRES_PORT` 时，同步修改 `DATABASE_URL`。已有数据卷的密码不会因修改环境变量自动更新。

## 常用命令

```sh
pnpm typecheck       # 检查前后端 TypeScript
pnpm lint            # Biome 检查
pnpm format          # Biome 格式化、自动修复
pnpm build           # 构建前后端
pnpm start           # 启动已构建的后端
pnpm --filter @ohmyapi/web preview  # 预览前端产物，默认 4173 端口
pnpm db:generate    # 根据 schema 生成待审核的 SQL 迁移
pnpm test:e2e       # 一条完整账户、网关、定价及计费流程：真实 CLI、PostgreSQL 和 HTTP
```

测试遵循 AGENTS.md：尽量减少数量，仅在必要时通过少量 e2e 场景验证完整流程。常规验证使用类型检查、Biome 和构建检查。

`test:e2e` 需要 Docker，会创建独立的临时 PostgreSQL 和应用进程，结束后清理。不会使用 `.env` 中的开发数据库或账号。

## 计费网关

支持 `POST /v1/chat/completions`、`POST /v1/responses` 和 `POST /v1/messages` 的 JSON 与 SSE 直通转发。默认关闭；开启后每次调用均进行余额准入、原子预占及按最终用量结算。

在 `.env` 配置稳定的 `CHANNEL_ENCRYPTION_KEY`（64 个十六进制字符），设置 `GATEWAY_ENABLED=true` 并重启。管理员在“渠道”配置端点、可用模型及倍率，在“模型 → 定价”配置模型单价和条件规则，在用户详情中授权模型；用户创建 API Key 时绑定渠道，之后通过对应端点调用。调用前由管理员手动入账；客户端必须显式传入输出 Token 上限。首轮计费支持文本与自定义函数工具。请求记录显示实际扣费、冻结额和价格明细，管理员可核对异常、追加冲正及核对钱包一致性。完整配置和调用示例见 [docs/gateway.md](docs/gateway.md)，结算规则及恢复说明见 [docs/billing.md](docs/billing.md)。

账户功能与权限约定见 [docs/accounts.md](docs/accounts.md)，分批规划见 [docs/implementation-plan.md](docs/implementation-plan.md)。
