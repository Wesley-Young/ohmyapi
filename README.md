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

升级已有数据库后先执行 `pnpm db:migrate`；本批迁移增加 Key 模型限制标记并移除强制改密字段。

生产环境请设置 `APP_ORIGIN` 为浏览器访问的完整 origin（如 `https://api.example.com`），并启用 `SESSION_COOKIE_SECURE=true`。Cookie 使用 HttpOnly、SameSite=Strict，生产 Secure Cookie 使用 `__Host-` 前缀。前端和 `/api` 应通过同一 origin 提供服务，反向代理将 `/api` 转发到 daemon，其余路径提供前端并回退到 `index.html`。

`/api/health` 是进程存活检查，`/api/ready` 检查数据库连接。服务启动时校验迁移、初始化状态和币种；不会自动迁移或创建管理员。

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
pnpm test:e2e       # 一条完整账户流程：真实 CLI、PostgreSQL 和 HTTP
```

测试遵循 AGENTS.md：尽量减少数量，仅在必要时通过少量 e2e 场景验证完整流程。常规验证使用类型检查、Biome 和构建检查。

`test:e2e` 需要 Docker，会创建独立的临时 PostgreSQL 和应用进程，结束后清理。不会使用 `.env` 中的开发数据库或账号。

账户功能与权限约定见 [docs/accounts.md](docs/accounts.md)，分批规划见 [docs/implementation-plan.md](docs/implementation-plan.md)。
