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

初始化后从 `.env` 移除 `BOOTSTRAP_ADMIN_USERNAME` 和 `BOOTSTRAP_ADMIN_PASSWORD`。再次运行初始化不会重置密码或新增管理员。第 0 批只建立管理员数据，登录与首次修改密码流程在第 1 批实现。

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
```

测试遵循 AGENTS.md：尽量减少数量，仅在必要时通过少量 e2e 场景验证完整流程。常规验证使用类型检查、Biome 和构建检查。

数据库结构与计费约定见 [docs/database.md](docs/database.md)，分批规划见 [docs/implementation-plan.md](docs/implementation-plan.md)。
