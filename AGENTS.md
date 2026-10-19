# 开发约定

## 项目

- pnpm v12 workspace，`daemon/` 是后端，`web/` 是前端，`packages/` 是发布到 npm 的 `@ohmyapi/*` 共享包。
- 后端使用 `@fraqjs/kernel`、Hono 和 tRPC；前端使用 Vite、React Router 和 Chakra UI v3；格式化和静态检查使用 Biome。
- 设计调整沿用现有技术栈和组件，不引入其他 UI 框架。
- 前端的服务端数据用 TanStack Query 管理，使用 tRPC 提供的 `queryOptions`、`mutationOptions` 和缓存失效接口，不自己写查询或变更状态的 hooks。
- 只在开发者要求时修改 `README.md`。

## 后端结构

- `daemon/src/plugins/` 按业务模块划分，目录名 `plugins` 不改。
- 模块内文件：`index.ts` 装配插件，`service.ts` 是主 service，`schemas.ts` 是 RPC 输入校验，`router.ts` 是 tRPC 路由，`api.ts` 是公开 API（`/api/v1`）路由。主 service 命名为 `XxxService`，拆出的 service 用名词命名。
- 公开 API 用 `@hono/zod-openapi` 定义，由 `daemon/src/openapi/router.ts` 汇总；响应 schema 显式声明，只返回公开的字段。文档元数据用 zod 的 `.meta()`，不用 `.openapi()`（在 `@hono/zod-openapi` 加载前创建的 schema 没有这个方法）。通用约定写在 `docs/api/README.md`。文档和接口描述用肯定句写清行为和约定。
- `daemon/src/core/` 只放与应用无关的基础代码。
- daemon 不构建，开发和生产都由 Node 的 type stripping 直接运行源码：只用可擦除的 TypeScript 语法（`erasableSyntaxOnly`），类型导入写 `import type`，相对导入写 `.ts` 后缀。tsc 只做类型检查，部署时先通过类型检查再启动。
- 配置在启动时由 `loadConfig()` 读取一次，插件通过 `ctx.config` 使用，不直接读 `process.env`。
- 模块间依赖单向，没有循环，由 Biome 的 `noImportCycles` 和 `noRestrictedImports` 检查。
- 业务代码抛 `AppError`，不依赖 tRPC 和公开 API 的传输层。网关通过 `SubscriptionChannels` 接口使用订阅渠道。
- 钱包余额只通过 `wallet/ledger.ts` 的 `postLedgerEntry` 变更；管理操作用 `recordAudit` 记录审计日志；计费请求的状态流转见 `billing/requests.ts`。

## 共享包

- `packages/protocols`（`@ohmyapi/protocols`）描述网关支持的 API 协议（端点、请求和响应结构、用量字段）和 `GatewayError`，不依赖其他包；计费策略和路由留在 daemon 对应的业务模块。新增端点时实现 `ApiProtocol` 并加入注册表。
- `packages/relay`（`@ohmyapi/relay`）负责请求生命周期、请求体读取和上游响应的转发，只依赖 `@ohmyapi/protocols`。计费、记录等收尾通过 `ResponseObserver` 和 `onFinish` 交给使用方，网关的用法见 `daemon/src/plugins/gateway/response.ts`。
- 共享包不依赖应用框架、存储和出站网络库，接口只用 Web 标准的 `Request`、`Response`，由 Biome 的 `noRestrictedImports` 检查。ohmyswitch 等其他项目也使用这些包，改动公开接口时按 semver 升级版本。
- 包的 `exports` 带有 `@ohmyapi/source` 条件，指向源码：类型检查通过 `customConditions` 读源码，运行 daemon 的命令都带 `--conditions=@ohmyapi/source`，在 oma 中开发和生产都使用包的源码。`dist` 只用于发布到 npm，构建时由 `rewriteRelativeImportExtensions` 把相对导入改写为 `.js`。新增运行 daemon 源码的命令时同样带上这个条件。

## 前端结构

- `web/src/routes/` 只放页面，由 `main.tsx` 装配，页面之间不互相导入。
- 页面文件名与路由路径相同（kebab-case），默认导出的组件名是它的 PascalCase。index、动态参数和 `*` 路由没有路径名，用描述性名称。
- 共享或嵌入的界面放在 `components/`；`lib/` 只放数据和工具函数，不依赖界面。
- 上面的目录依赖规则由 Biome 的 `noRestrictedImports` 检查。
- 数据变更后的缓存刷新放在 `lib/cache.ts`，格式化用 `lib/format.ts`，品牌色用 `lib/theme.ts` 的常量。
- 与后端对应的枚举（端点、订阅平台、状态等）从 `RouterOutputs` 派生类型，文案表用 `satisfies Record<..., string>` 覆盖全部取值。

## 测试

- 只在开发者要求时增加测试或测试命令。
- 只写 e2e 测试，通过真实的应用入口验证完整流程，不写单元测试或集成测试。
- 测试只覆盖关键业务流程，用少量场景覆盖重要行为，不测试简单改动或实现细节。
- 日常验证使用类型检查、Biome 检查和构建。

## 前端设计

开发者的指示优先于本节。本项目采用 Stripe 的设计语言。

### 视觉

- 参考 Stripe 的排版、比例和视觉层次：字重和字号层次清晰，对齐精确，留白充足，边框细，阴影克制。
- 页面背景为纯白 `#ffffff`，辅助表面用中性灰。背景不带色调，不用彩色渐变或装饰性背景。
- 文字以黑色和中性灰为主，主文字为 `#171717`。紫色 `#635bff` 只用于主要操作和少量强调；状态色只用来表示状态。
- 按钮简洁，圆角统一。主按钮为紫底白字的胶囊形，悬停反馈克制。
- 标题字号服务于内容，不为装饰放大。首页名称是视觉焦点，字号窄屏 48px、宽屏 64px。
- 动效轻微且有用途，遵循系统的减少动态效果设置。
- 列表中的状态、端点、定价状态、倍率等附加信息用 Chakra Badge 展示，不用 `·` 拼接；标签组可以换行。

### 首页

- 首页只有名称 `ohmyapi` 和下方的“登录”按钮，两者作为一组在视口中水平、垂直居中，单列紧凑排列。
- 不加介绍文本、标语、功能卖点、概念图、导航、服务状态或装饰性页脚。

### 表单与交互

- 添加和编辑用户、Key、渠道、模型、价格规则等，都在 Chakra Dialog 弹窗中进行，不在列表页内展开表单。弹窗需管理焦点，窄屏下可滚动。
- 认证等单一任务的页面使用居中的紧凑单列布局，突出主要输入和操作。
- 标签和按钮文案简短直接。辅助文本只在帮助用户做决定或从错误中恢复时添加。
- 使用可见的字段标签、行内校验和常见图标，不写冗长的说明。
- 用现有 Chakra UI 组件组合和定制界面，保留语义、可访问名称、键盘焦点、禁用和加载状态。
- 窄屏以及校验、加载状态下保持居中和安全边距，不出现横向溢出；内容超出视口时正常滚动。
