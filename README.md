# ohmyapi

Simple AI API Gateway

## 源码部署

需要 Node.js 24.13+、pnpm v12、PostgreSQL 17。应用直接在 Git 工作区构建、运行；仅使用附带的数据库时需要 Docker。安装依赖时保留开发依赖，部署脚本会使用锁文件中的版本。

```sh
git clone git@github.com:Wesley-Young/ohmyapi.git ohmyapi
cd ohmyapi
cp .env.example .env
chmod 600 .env
```

编辑 `.env`：

- `APP_ORIGIN`：浏览器访问的完整地址，如 `http://127.0.0.1:8000` 或 `http://服务器IP:8000`，不带末尾斜杠。通过 HTTP 访问时使用 `SESSION_COOKIE_SECURE=false`。
- `DATABASE_URL`：PostgreSQL 连接地址；使用附带数据库时，将示例中的本地密码替换为强密码，同时修改 `POSTGRES_PASSWORD`，与连接地址中的密码一致。密码在 URL 中需要编码。已有数据卷的密码不会因修改配置而自动改变。
- `BOOTSTRAP_ADMIN_USERNAME`、`BOOTSTRAP_ADMIN_PASSWORD`：首次初始化的管理员账号，密码至少 8 字符。
- `BILLING_CURRENCY`：金额展示标记，支持 USD、CNY。余额、价格和扣费按系统内的数值计算，**标记本身不触发汇率换算**，金额保留六位小数。
- `CHANNEL_ENCRYPTION_KEY`：启动应用必需的 64 位十六进制密钥，用于加密渠道凭据。按配置文件中的命令生成一次，后续保持不变，与数据库一起备份。

网关默认开启，配置好渠道、模型、定价和余额后即可转发请求，转发时会执行余额预留和计费。

首次部署：

```sh
pnpm db:up          # 已有 PostgreSQL 时跳过
pnpm run setup      # 校验配置 → 安装依赖 → 构建 → 迁移 → 初始化
pnpm start          # 生产模式，默认监听 127.0.0.1:8000
```

需要特别注意的是，`setup`、`deploy` 与 pnpm 内置命令同名，执行项目脚本时**请保留 `run`**。初始化后请移除 `.env` 中的两个 `BOOTSTRAP_ADMIN_*` 配置。

### 二改与更新

构建会替换工作区中的产物，更新前先在运行 `pnpm start` 的终端按 Ctrl+C 停止应用。备份数据库和渠道加密密钥，处理好本地修改后再拉取更新；也可以直接部署自己的修改。

```sh
git pull --ff-only
pnpm run deploy # 校验配置 → 安装依赖 → 构建 → 迁移
pnpm start
```

按顺序执行，只有 `pnpm run deploy` 成功后才重新启动应用。此方式更新期间会短暂不可用。任一步失败时部署脚本会退出；修复后重新执行。数据库迁移不会随 Git 版本回退自动撤销。

## 本地开发

```sh
pnpm install
cp .env.example .env
```

编辑 `.env` 中的数据库连接、管理员账号和初始密码，并按示例中的命令生成、填写 `CHANNEL_ENCRYPTION_KEY`。开发模式下不设置 `APP_ORIGIN`，由请求自动确定来源；从生产配置切回开发时，注释掉该项。然后执行：

```sh
pnpm db:up       # 已有 PostgreSQL 时跳过
pnpm db:migrate
pnpm db:init
pnpm dev
```

初始化后移除两个 `BOOTSTRAP_ADMIN_*` 配置。前端为 `http://127.0.0.1:5173`，API 默认监听 `127.0.0.1:8000`。

## 常用命令

```sh
pnpm build          # 构建前后端
pnpm run setup      # 首次源码部署
pnpm run deploy     # 二改或更新后准备部署
pnpm start          # 生产模式启动网页和 API
pnpm typecheck      # 类型检查
pnpm lint           # Biome 检查
pnpm format         # 格式化
pnpm db:generate    # 生成数据库迁移
```
