# ohmyapi

Simple AI API Gateway

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

## 常用命令

```sh
pnpm build        # 构建前后端
pnpm start        # 启动已构建的后端
pnpm typecheck    # 类型检查
pnpm lint         # Biome 检查
pnpm format       # 格式化
pnpm db:generate  # 生成数据库迁移
```
