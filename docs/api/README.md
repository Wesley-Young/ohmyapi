# ohmyapi V1 API

ohmyapi 的管理和查询接口，路径都以 `/api/v1` 开头。各接口的路径、参数和响应字段以运行中服务的 OpenAPI 文档为准：

```
GET /api/v1/openapi.json
```

可以导入 Postman、Scalar 等工具，或用于生成 SDK。本文说明 OpenAPI 未规定、各接口共用的约定。

## 认证

在 `Authorization` 头中携带凭据：

```sh
curl https://example.com/api/v1/me \
  -H "Authorization: Bearer sk-..."
```

| 凭据                        | 用于              | 获取方式                                       |
| --------------------------- | ----------------- | ---------------------------------------------- |
| API Key（`sk-...`）         | `/api/v1/me*`     | 在控制台的 Key 页面创建，与调用网关的 Key 相同 |
| 管理令牌（`oma_admin_...`） | `/api/v1/admin/*` | 管理员在控制台的「个人信息」页面创建           |

缺少凭据，或者凭据无效、已过期、所属用户已停用时，返回 `401`。

### 管理令牌

- 令牌以创建它的管理员的身份操作。审计日志中的操作人是该管理员，并在 `metadata.adminTokenId` 中记录令牌。
- 明文只在创建时显示一次，服务端只保存哈希。
- 有效期可以留空，表示长期有效。
- 所属管理员被停用或删除后，令牌立即失效；被降为普通用户时，其令牌全部吊销。
- 每个接口需要的权限见 OpenAPI 文档，令牌缺少所需权限时返回 `403`。

| 权限           | 说明                     |
| -------------- | ------------------------ |
| `users:read`   | 查看用户                 |
| `users:write`  | 创建用户、启用或停用用户 |
| `wallet:read`  | 查看余额                 |
| `wallet:write` | 调整余额                 |

## 错误

非 2xx 响应的格式统一为：

```json
{ "error": { "code": "unauthorized", "message": "API Key 无效或已过期" } }
```

程序应根据 `code` 判断错误类型；`message` 是给人看的说明，内容可能调整。

| `code`                   | HTTP 状态 | 说明                                 |
| ------------------------ | --------- | ------------------------------------ |
| `bad_request`            | 400       | 参数无效                             |
| `unauthorized`           | 401       | 未认证或凭据无效                     |
| `forbidden`              | 403       | 没有权限                             |
| `not_found`              | 404       | 接口或资源不存在                     |
| `conflict`               | 409       | 与现有数据冲突                       |
| `precondition_failed`    | 412       | 前置条件不满足                       |
| `payload_too_large`      | 413       | 请求体超过 64 KB                     |
| `unsupported_media_type` | 415       | Content-Type 需为 `application/json` |
| `too_many_requests`      | 429       | 请求过于频繁                         |
| `internal_error`         | 500       | 服务内部错误                         |
| `bad_gateway`            | 502       | 依赖的上游服务出错                   |

## 金额

金额都是十进制字符串。请求中最多六位小数，如 `"10"`、`"-0.5"`；响应固定六位小数，如 `"10.000000"`。`currency` 是显示用的货币单位。

## 分页

列表接口使用游标分页：

```sh
curl "https://example.com/api/v1/admin/users?limit=50" -H "Authorization: Bearer oma_admin_..."
```

```json
{ "items": [], "nextCursor": "eyJ..." }
```

把 `nextCursor` 作为下一次请求的 `cursor` 参数继续读取，`nextCursor` 为 `null` 时表示没有更多数据。`limit` 默认 20，最大 100。请原样传回游标。

## 幂等

调整余额等写操作必须携带 `Idempotency-Key` 请求头，可以用支付订单号等业务标识：

- 由 1–128 位字母、数字或 `_ . : -` 组成。
- 同一管理员重复提交相同的键时，返回首次的结果，网络超时等情况下可以放心重试。
- 相同的键用于参数不同的请求时，返回 `409`。

创建用户以用户名去重：用户名已存在时返回 `409`，可按用户名查询已有用户。

## 其他约定

- 时间都是 ISO 8601 格式的 UTC 时间，如 `2026-10-15T08:00:00.000Z`。
- 可为空的字段始终存在，值为 `null`。
- 每个响应都带 `x-request-id` 头，反馈问题时请附上。
- 响应带 `Cache-Control: no-store`。
