# ohmyapi

Simple yet capable AI gateway, yours to extend.

## 环境要求

- Node.js 24.13+
- pnpm v12
- PostgreSQL 17（使用附带的 PostgreSQL 时需要 Docker）

## 配置

```sh
git clone git@github.com:Wesley-Young/ohmyapi.git ohmyapi
cd ohmyapi
cp .env.example .env
chmod 600 .env
```

编辑 `.env`：

| 配置项 | 说明 |
| --- | --- |
| `APP_ORIGIN` | 浏览器访问的完整地址，不带末尾斜杠，如 `http://127.0.0.1:8000`。生产部署必填，本地开发时注释掉。 |
| `SESSION_COOKIE_SECURE` | 通过 HTTP 访问时设为 `false`。 |
| `DATABASE_URL` | PostgreSQL 连接地址，密码中的特殊字符需进行 URL 编码。 |
| `POSTGRES_PASSWORD` | 附带 PostgreSQL 的密码，须与 `DATABASE_URL` 中的一致。数据卷创建后，修改该项不会更改已有数据库的密码。 |
| `BOOTSTRAP_ADMIN_USERNAME`<br>`BOOTSTRAP_ADMIN_PASSWORD` | 初始管理员的用户名和密码，密码至少 8 个字符。初始化完成后删除这两项。 |
| `BILLING_CURRENCY` | 金额显示的货币单位，可选 `USD` 或 `CNY`。仅影响显示，不做汇率换算。金额精确到小数点后六位。 |
| `CHANNEL_ENCRYPTION_KEY` | 渠道凭据的加密密钥，由 64 个十六进制字符组成，生成命令见 `.env.example`。生成后不可更改，需与数据库一起备份。 |

## 部署

```sh
pnpm db:up          # 使用已有 PostgreSQL 时跳过
pnpm run setup      # 校验配置、安装依赖、构建、迁移数据库、初始化
pnpm start          # 以生产模式启动，默认监听 127.0.0.1:8000
```

`setup` 和 `deploy` 与 pnpm 内置命令同名，须通过 `pnpm run` 执行。

登录后配置渠道、模型、定价和用户余额，即可通过网关转发请求。

### 更新

更新前停止应用，并备份数据库和 `CHANNEL_ENCRYPTION_KEY`。

```sh
git pull --ff-only  # 部署本地修改时跳过
pnpm run deploy     # 校验配置、安装依赖、构建、迁移数据库
pnpm start
```

`deploy` 失败时不要启动应用，修复后重新执行。回退代码版本不会撤销已执行的数据库迁移。

## 本地开发

```sh
pnpm install
pnpm db:up          # 使用已有 PostgreSQL 时跳过
pnpm db:migrate
pnpm db:init
pnpm dev
```

前端地址为 `http://127.0.0.1:5173`，API 默认监听 `127.0.0.1:8000`。

## 常用命令

```sh
pnpm build          # 构建前后端
pnpm start          # 以生产模式启动
pnpm typecheck      # 类型检查
pnpm lint           # Biome 检查
pnpm format         # 格式化
pnpm db:generate    # 生成数据库迁移脚本
```
