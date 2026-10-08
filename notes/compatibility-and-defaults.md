# 特殊适配与时效性默认值

## OpenAI / Codex

- **GPT-5/6 搜索默认价**：模型名转小写，去掉开头的 `openai/`，匹配 `gpt-5` 或 `gpt-6`，其后须为 `.`、`-` 或名称结束；普通与 Preview 搜索均为 `10.000000` / 千次调用。USD/CNY 数值相同，价格独立于模型 Token 单价。

  代码：[search-defaults.ts](../daemon/src/plugins/pricing/search-defaults.ts)：`defaultSearchPrices`、`applySearchDefaults`。维护时核对：搜索定价、模型系列、命名空间或后缀规则变化。

- **默认价适用边界**：支持 `gpt-5`、`gpt-6` 及版本、日期、Codex 后缀；`gpt-50`、独立 `codex-*`、GPT-4、o 系列和其他模型无搜索默认价。只对 `null` 补默认值，显式价格和 `0` 优先。

  代码：[search-defaults.ts](../daemon/src/plugins/pricing/search-defaults.ts)；[admission.ts](../daemon/src/plugins/billing/admission.ts)：`reservationAmount`。维护时核对：新增系列或别名；缺价模型要使用搜索时需显式定价。

- **默认价的快照与展示**：请求锁价时补默认值并写入快照；恢复历史快照时沿用保存值。管理员接口保留原始空值，另返回 `searchDefaults`；广场、列表和预览使用有效价，渠道倍率继续生效。

  代码：[pricing/service.ts](../daemon/src/plugins/pricing/service.ts)：`lock`、`snapshot`、`restore`、`list`、`plaza`、`preview`；[Pricing.tsx](../web/src/routes/Pricing.tsx)。维护时核对：调整默认价时同步检查展示、预占、结算及历史恢复，保留显式 `0`。

- **搜索默认价来源**：代码标注来源为 [OpenAI API Pricing](https://developers.openai.com/api/docs/pricing)。

  代码：[search-defaults.ts](../daemon/src/plugins/pricing/search-defaults.ts)。维护时核对：搜索调用费是否仍为每千次 `10`，以及 GPT-5/6 各型号是否沿用相同规则。

- **Codex 自动审核模型**：仅精确名称 `codex-auto-review` 显示复制价格按钮；来源为已定价的 `gpt-5.6-luna`，文案固定为“复制 GPT-5.6 Luna 价格”。复制会用来源模型的全部原始规则替换目标规则，属于一次性操作；来源后续改价不会自动同步。搜索空值保留为空，`codex-auto-review` 本身无 GPT-5/6 搜索默认价。

  代码：[Models.tsx](../web/src/routes/Models.tsx)；[Pricing.tsx](../web/src/routes/Pricing.tsx)：`copyLunaPrice`、`lunaModelId`。维护时核对：自动审核模型或推荐来源模型改名、换代，或两者实际价格不再相同；复制关系是仓库约定，代码未记录官方定价依据。

- **GPT 导入预设**：名称包含 `gpt` 时推荐，可手动切换；上下文从 `272001` Token 起，输入、缓存读、缓存写为基础价 `2×`，输出为 `1.5×`。预设在导入时生成并保存，调整代码不会更新已有规则。

  代码：[models-dev.ts](../web/src/lib/models-dev.ts)：`suggestedPreset`、`buildImportRules`；[model-import.tsx](../web/src/components/model-import.tsx)。维护时核对：各型号长上下文门槛或倍率变化；当前规则按宽泛名称推荐，需要逐型号确认；该预设是仓库约定，代码未记录官方定价依据。

- **Responses namespace**：接受非空 `name`、数组 `tools`，子工具只能是 `function` 或 `custom`；顶层客户端 `function`、`custom` 也允许。

  代码：[admission.ts](../daemon/src/plugins/billing/admission.ts)：`isBillableTool`。维护时核对：namespace 嵌套形式、子工具类型和计费语义变化。

- **Codex 工具名称**：`multi_agent_v1`、`mcp__code_review`、`mcp__codex_app`、`mcp__cua_repl`、`mcp__node_repl` 等依靠上述结构规则接入。代码没有按这些名称建立白名单，也没有逐个 agent/harness 的专用分支。

  代码：[admission.ts](../daemon/src/plugins/billing/admission.ts)：`isBillableTool`。维护时核对：先核对实际请求结构，避免把客户端 namespace 工具误判为托管工具。

- **Codex 响应头**：允许向客户端返回 `x-codex-turn-state`、`x-reasoning-included`；这里是响应头白名单，请求头只按当前协议构造。

  代码：[gateway/service.ts](../daemon/src/plugins/gateway/service.ts)：`forward`。维护时核对：客户端新增状态头、要求回传请求头或修改状态延续方式。

- **跨请求状态与异步模式**：非空 `previous_response_id`、`conversation`、`prompt`、`audio`、`prediction` 被计费准入拒绝；`background: true` 被拒绝。当前只接同步 HTTP 请求和 SSE，未提供 Responses 后续检索或 WebSocket 路由。

  代码：[admission.ts](../daemon/src/plugins/billing/admission.ts)：`validateBillableRequest`；[gateway/service.ts](../daemon/src/plugins/gateway/service.ts)：`body`；[http/index.ts](../daemon/src/plugins/http/index.ts)。维护时核对：harness 开始使用服务端上下文、后台执行或其他传输方式。

- **OpenAI 兼容端点和输出上限**：推理支持 `/v1/chat/completions` 和 `/v1/responses`，使用上游 Bearer 凭据。Responses 识别 `max_output_tokens`，显式值至少 `16`；Chat 可选 `max_completion_tokens` 或 `max_tokens`，二者同时提供会报错。未提供上限时仅使用模型输出上限做预占估算，转发保留缺省值或 `null`。

  代码：[catalog/service.ts](../daemon/src/plugins/catalog/service.ts)：`endpoints`；[gateway/service.ts](../daemon/src/plugins/gateway/service.ts)：`forward`；[admission.ts](../daemon/src/plugins/billing/admission.ts)：`validateBillableRequest`。维护时核对：API 字段名、最小值、鉴权和客户端缺省行为，避免为了预占改写上游输出行为。

- **Chat 流式 usage**：强制合并 `stream_options.include_usage: true`，保留其余流式选项；识别 usage-only 的空 `choices` chunk 与 `[DONE]`。

  代码：[gateway/service.ts](../daemon/src/plugins/gateway/service.ts)：`forward`；[usage.ts](../daemon/src/plugins/gateway/usage.ts)。维护时核对：兼容供应商是否支持该选项，末尾 usage 与结束标志格式是否变化。

- **Responses 终态**：接受状态 `completed`、`incomplete`、`failed`、`cancelled`、`canceled`；事件接受对应 `response.*` 及 `response.done`。终态与错误标记、最终 usage 分开记录。

  代码：[usage.ts](../daemon/src/plugins/gateway/usage.ts)：`responseTerminalStatuses`、`responseTerminalEvents`、`observe`。维护时核对：新终态、事件别名或 usage 出现时机变化。

- **Token 与缓存口径**：Chat 使用 `prompt_tokens` / `completion_tokens`，Responses 使用 `input_tokens` / `output_tokens`；从输入中扣除 `prompt_tokens_details` 或 `input_tokens_details` 中的 `cached_tokens`、`cache_write_tokens`，上下文总量保留原输入总量。

  代码：[usage.ts](../daemon/src/plugins/gateway/usage.ts)：`normalize`。维护时核对：兼容供应商是否把缓存计入输入总量，缓存写入字段和长上下文计费口径。

- **Responses 搜索工具识别**：接受 `web_search`、`web_search_preview` 及 `_YYYY_MM_DD` 后缀；`max_tool_calls` 用作搜索预占调用数，缺省 `1`；每请求只允许一种搜索变体。

  代码：[billing/search.ts](../daemon/src/plugins/billing/search.ts)：`searchToolKind`、`searchRequest`。维护时核对：工具版本命名、调用上限含义和混合工具计费。

- **Chat 隐式搜索**：模型名匹配结尾的 `search-preview` / `search-api`（可带 `-YYYY-MM-DD`），或提供 `web_search_options` 时启用。Preview 后缀归入 Preview，其他归入普通搜索；预占估算 `1` 次，有 usage 且无明确搜索报告时也按 `1` 次。

  代码：[billing/search.ts](../daemon/src/plugins/billing/search.ts)：`searchRequest`；[search-usage.ts](../daemon/src/plugins/gateway/search-usage.ts)：`observe`。维护时核对：搜索专用模型改名、选项和隐式调用费变化；出现明确计数时改用报告值。

- **Responses 搜索实际用量**：从 `response.output_item.done` 和最终 `output` 收集已完成的 `web_search_call`，按 ID/索引去重；`search` 计调用费，`open_page`、`find` 跳过调用费。明确报告的搜索计数覆盖推断值，报告字段优先级见跨供应商规则。

  代码：[search-usage.ts](../daemon/src/plugins/gateway/search-usage.ts)：`observeItem`、`observe`。维护时核对：输出项与 action 名称、一次搜索含多查询时的收费单位和明确计数口径。

- **额外托管工具费用**：`file_search_call`、`image_generation_call`、`computer_call`、`code_interpreter_call` 会阻止自动结算；当前托管工具计费只支持已识别的 Web Search。

  代码：[search-usage.ts](../daemon/src/plugins/gateway/search-usage.ts)；[admission.ts](../daemon/src/plugins/billing/admission.ts)。维护时核对：新增收费工具的准入、用量采集及价格支持。

## Anthropic

- **Messages 版本与鉴权**：推理端点为 `/v1/messages`，使用上游 `x-api-key`。`anthropic-version` 取客户端请求值，缺省 `2023-06-01`，仅接受日期格式；透传 `anthropic-beta`。

  代码：[gateway/service.ts](../daemon/src/plugins/gateway/service.ts)：`forward`；[catalog/service.ts](../daemon/src/plugins/catalog/service.ts)：`endpoints`。维护时核对：API 版本、beta 能力和鉴权方式变化。

- **输出上限**：Messages 必须提供 `max_tokens`，为至少 `1` 且不超过模型输出上限的整数。

  代码：[admission.ts](../daemon/src/plugins/billing/admission.ts)：`validateBillableRequest`。维护时核对：客户端缺省行为和输出上限字段变化。

- **Anthropic 分段 usage**：合并 message envelope 的 usage；在 `message_stop` 或带 `stop_reason` 的完整消息确认结束。

  代码：[usage.ts](../daemon/src/plugins/gateway/usage.ts)：`observe`。维护时核对：起始/增量事件字段、usage 是累计值还是增量值发生变化。

- **Token 与缓存口径**：使用 `input_tokens`、`output_tokens`，缓存读写取独立字段 `cache_read_input_tokens`、`cache_creation_input_tokens`；上下文总量为输入加缓存读写。

  代码：[usage.ts](../daemon/src/plugins/gateway/usage.ts)：`normalize`。维护时核对：缓存拆分字段、输入是否含缓存以及长上下文计算口径。

- **客户端工具**：允许未提供 `type`、具有字符串 `name` 和对象 `input_schema` 的工具定义；内容中的 `server_tool_use` 只允许 `name: web_search`，并允许 `web_search_tool_result`。

  代码：[admission.ts](../daemon/src/plugins/billing/admission.ts)：`isBillableTool`、`validateBillableRequest`。维护时核对：客户端工具结构、服务端工具和工具结果类型变化。

- **搜索工具与预占**：搜索工具需匹配 `web_search_YYYYMMDD` 且 `name` 为 `web_search`；预占累加各工具的 `max_uses`，缺省 `1`，搜索价格需要显式配置。

  代码：[billing/search.ts](../daemon/src/plugins/billing/search.ts)：`searchToolKind`、`searchRequest`；[admission.ts](../daemon/src/plugins/billing/admission.ts)：`reservationAmount`。维护时核对：工具版本命名、`max_uses` 含义及供应商搜索调用费。

- **搜索用量与未知费用**：服务端搜索调用数取 `usage.server_tool_use.web_search_requests`。确认用了搜索但终态缺少此计数时阻止自动结算；其他服务端工具和非零未知服务端工具用量也会阻止自动结算。

  代码：[search-usage.ts](../daemon/src/plugins/gateway/search-usage.ts)：`observe`。维护时核对：报告字段、累计方式及新增托管工具收费。

- **上游模型列表版本头**：获取渠道模型列表时固定发送 `anthropic-version: 2023-06-01`，同时发送 `x-api-key` 和 Bearer；分页字段见跨供应商模型列表规则。

  代码：[catalog/service.ts](../daemon/src/plugins/catalog/service.ts)：`fetchChannelModels`。维护时核对：模型列表版本与鉴权要求；这里的版本头独立于推理请求的客户端版本。

## DeepSeek

- **DeepSeek 导入预设**：名称包含 `deepseek` 时推荐，可手动切换；上海时区周一至周五 `09:00–12:00`、`14:00–18:00` 四项 Token 价格均 `2×`。分钟区间为 `[540,720)`、`[840,1080)`，星期掩码为 `31`。在导入时生成并保存规则，调整预设不会更新已有模型规则。

  代码：[models-dev.ts](../web/src/lib/models-dev.ts)：`suggestedPreset`、`buildImportRules`；[model-import.tsx](../web/src/components/model-import.tsx)。维护时核对：供应商高峰时段、折扣或基础价口径变化；该预设是仓库约定，代码未记录官方定价依据。

- **兼容协议与搜索边界**：请求按渠道配置的兼容端点转发，没有 DeepSeek 专用的转发或 usage 分支。`enable_search: true` 被当前通用计费准入拒绝。

  代码：[gateway/service.ts](../daemon/src/plugins/gateway/service.ts)：`forward`；[billing/search.ts](../daemon/src/plugins/billing/search.ts)：`searchRequest`。维护时核对：实际渠道 usage 是否符合兼容协议，厂商扩展搜索是否需要独立计费支持。

## Google

- **models.dev 官方来源别名**：canonical publisher 为 `google` 时，除同名 provider 外，额外把 `google-vertex` 标记为官方来源。这是导入来源标记，推理仍按渠道的兼容端点处理。

  代码：[models-dev.ts](../web/src/lib/models-dev.ts)：`officialProviderAliases`、`officialMatcher`。维护时核对：发布者 ID、地域来源、套餐命名及官方来源关系变化。

## Alibaba

- **models.dev 官方来源别名**：canonical publisher 为 `alibaba` 时，除同名 provider 外，额外把 `alibaba-cn`、`alibaba-coding-plan`、`alibaba-coding-plan-cn`、`alibaba-token-plan`、`alibaba-token-plan-cn` 标记为官方来源。这是导入来源标记，推理仍按渠道的兼容端点处理。

  代码：[models-dev.ts](../web/src/lib/models-dev.ts)：`officialProviderAliases`、`officialMatcher`。维护时核对：发布者 ID、地域来源、套餐命名及官方来源关系变化。

## Moonshot AI

- **models.dev 官方来源别名**：canonical publisher 为 `moonshotai` 时，除同名 provider 外，额外把 `moonshotai-cn` 标记为官方来源。这是导入来源标记，推理仍按渠道的兼容端点处理。

  代码：[models-dev.ts](../web/src/lib/models-dev.ts)：`officialProviderAliases`、`officialMatcher`。维护时核对：发布者 ID、地域来源、套餐命名及官方来源关系变化。

## MiniMax

- **models.dev 官方来源别名**：canonical publisher 为 `minimax` 时，除同名 provider 外，额外把 `minimax-cn`、`minimax-coding-plan`、`minimax-coding-plan-cn` 标记为官方来源。这是导入来源标记，推理仍按渠道的兼容端点处理。

  代码：[models-dev.ts](../web/src/lib/models-dev.ts)：`officialProviderAliases`、`officialMatcher`。维护时核对：发布者 ID、地域来源、套餐命名及官方来源关系变化。

## Zhipu AI / Z.ai

- **models.dev 官方来源别名**：canonical publisher 为 `zhipuai` 时，除同名 provider 外，额外把 `zhipuai-cn`、`zai`、`zai-coding-plan` 标记为官方来源。这是导入来源标记，推理仍按渠道的兼容端点处理。

  代码：[models-dev.ts](../web/src/lib/models-dev.ts)：`officialProviderAliases`、`officialMatcher`。维护时核对：发布者 ID、地域来源、套餐命名及官方来源关系变化。

## models.dev（外部数据来源）

- **数据入口与刷新**：浏览器直接获取 [models.dev/api.json](https://models.dev/api.json)，超时 `20s`；查询缓存 `5min`，自动重试 `1` 次。

  代码：[models-dev.ts](../web/src/lib/models-dev.ts)：`fetchModelsDev`；[model-import.tsx](../web/src/components/model-import.tsx)。维护时核对：入口、数据新鲜度、CORS 和响应结构变化。

- **数据字段与容量回退**：解析依赖 `provider.models`、`model.id/name/canonical_model_id`、`cost.input/output/cache_read/cache_write`、`limit.input/context/output`。只导入同时具有输入、输出价格的有效条目；输入容量优先 `limit.input`，其次 `limit.context`，缺省 `1,000,000`，输出缺省 `128,000`。

  代码：[models-dev.ts](../web/src/lib/models-dev.ts)：`fetchModelsDev`。维护时核对：数据结构、Token 容量语义和价格计量单位。

- **官方来源判定**：根据 canonical publisher、模型别名和各供应商章节所列的 provider 别名标记官方；缺少 canonical 信息时仅从唯一发布者推断，不使用固定模型清单。

  代码：[models-dev.ts](../web/src/lib/models-dev.ts)：`officialMatcher`。维护时核对：发布者冲突、模型别名及 `canonical_model_id` 格式变化。

- **价格精度与手动换算**：来源价格按 USD / 百万 Token 读取，转换到六位小数时向上舍入。USD 直接用来源价，CNY 界面要求填写正数 `USD → CNY` 系数再调用 `convertPrices`；代码没有硬编码汇率。此导入换算入口与货币标记本身、GPT-5/6 搜索默认价的规则分别实现。

  代码：[models-dev.ts](../web/src/lib/models-dev.ts)：`sourcePrice`、`convertPrices`；[model-import.tsx](../web/src/components/model-import.tsx)。维护时核对：来源币种、精度和项目货币策略变化时同步核对已有入口。

- **导入预设与覆盖行为**：可选预设固定为 `none`、`gpt`、`deepseek`，按模型名称推荐后可手动切换。导入已有模型会覆盖启用状态、Token 上限和全部定价规则；保存的是当次生成的规则。

  代码：[models-dev.ts](../web/src/lib/models-dev.ts)：`suggestedPreset`、`buildImportRules`；[model-import.tsx](../web/src/components/model-import.tsx)；[catalog/service.ts](../daemon/src/plugins/catalog/service.ts)：`importModelsInput`。维护时核对：推荐名称、预设范围和已保存价格的覆盖风险。

## 跨供应商兼容规则与项目默认值

- **转发端点**：固定支持 `/v1/chat/completions`、`/v1/responses`、`/v1/messages`；使用相同端点转发。Base URL 去掉尾部 `/`，以 `/v1` 结尾时去重该路径前缀。

  代码：[catalog/service.ts](../daemon/src/plugins/catalog/service.ts)：`endpoints`；[gateway/service.ts](../daemon/src/plugins/gateway/service.ts)：`forward`；[schema/common.ts](../daemon/src/plugins/database/schema/common.ts)。维护时核对：新 API 版本、供应商原生端点或不同 Base URL 约定；端点枚举也涉及数据库。

- **兼容模型列表**：本地 `GET /v1/models` 返回已启用、已定价、渠道可用且调用者有权限的模型，`owned_by` 固定为 `ohmyapi`；上游列表采用 `/v1/models`，同时发送 Bearer、`x-api-key` 和固定 `2023-06-01` 版本头，分页使用 `has_more` / `last_id` / `after_id`。

  代码：[gateway/service.ts](../daemon/src/plugins/gateway/service.ts)：`listModels`；[catalog/service.ts](../daemon/src/plugins/catalog/service.ts)：`fetchChannelModels`。维护时核对：客户端是否需要更多模型字段，上游模型列表及分页协议是否变化。

- **响应头和拒绝状态**：除 Codex 头外，仅复制 `content-type`、`retry-after` 和三项 `x-ratelimit-*-requests` 头。无 usage、明确错误且 HTTP 状态在 `400/401/403/404/405/413/415/422/429` 时才作为安全拒绝释放预占；重定向被拒绝。

  代码：[gateway/service.ts](../daemon/src/plugins/gateway/service.ts)：`forward`。维护时核对：新限流头、新错误状态和“请求是否执行”的供应商语义。

- **内容与付费工具边界**：`n` 若提供只能为 `1`，`modalities` 若提供只能含 `text`。拒绝图片、音频、文件、视频、computer use 等内容；托管工具只支持已识别的 Web Search。仅按协议内容检查，工具 schema、examples 和业务数据保持原样。

  代码：[admission.ts](../daemon/src/plugins/billing/admission.ts)。维护时核对：多模态、新托管工具或多候选输出上线时同时设计用量和费用支持。

- **搜索报告字段优先级**：`usage.server_tool_use.web_search_requests` 优先于 `tool_usage.web_search.num_requests`；明确报告计数覆盖推断值。`enable_search: true` 当前拒绝，`web_search_options` 仅允许用于 Chat Completions。

  代码：[search-usage.ts](../daemon/src/plugins/gateway/search-usage.ts)：`observe`；[billing/search.ts](../daemon/src/plugins/billing/search.ts)：`searchRequest`。维护时核对：兼容渠道的扩展报告字段、计数含义和新增搜索模式。

- **未知用量与人工核对**：正数音频、图像、视频 Token、未知收费工具、无效或不完整 usage 会阻止自动结算；无法确认完整费用的响应进入 `needs_review`。

  代码：[usage.ts](../daemon/src/plugins/gateway/usage.ts)；[search-usage.ts](../daemon/src/plugins/gateway/search-usage.ts)；[gateway/service.ts](../daemon/src/plugins/gateway/service.ts)：`summary`。维护时核对：同时检查准入、请求预占、SSE/JSON 观察、快照、结算及人工核对入口，保留计费证据。

- **模型容量缺省**：输入 `1,000,000`、输出 `128,000` Token；用于手动创建、渠道占位和外部数据缺失时的回退。输入容量作为元数据保存，不用作 JSON 字节上限，也不裁剪输入预占估算；输出上限用于准入和估算。

  代码：[catalog/service.ts](../daemon/src/plugins/catalog/service.ts)、[schema/catalog.ts](../daemon/src/plugins/database/schema/catalog.ts)、[Catalog.tsx](../web/src/routes/Catalog.tsx)、[models-dev.ts](../web/src/lib/models-dev.ts)；数据库缺省也在迁移中。

- **预占 tokenizer**：所有模型统一采用 `o200k_base`，对 JSON 序列化后的输入按 `4096` 字符分块估算。余量为 `ceil(tokens × 1.25) + 256`；最终计费用上游 usage。

  代码：[estimation.ts](../daemon/src/plugins/billing/estimation.ts)；新模型 tokenizer、工具 schema 或长文本分布变化时核对预占误差。

- **输出预占估算**：同用户、渠道、模型、端点最近 `100` 条已结算且最终 usage 请求；至少 `5` 个样本时取 P95 并加同样余量，否则回退 `4096` Token；估算下限 `512`，最后受输出上限约束。

  代码：[billing/service.ts](../daemon/src/plugins/billing/service.ts)：`reserve`；[estimation.ts](../daemon/src/plugins/billing/estimation.ts)。

- **搜索计数上限**：`10,000` 次，约束准入、用量采集、人工填写和数据库字段。搜索去重标识最多 `20,000` 个，调用 ID 最长 `256`。

  代码：[billing/search.ts](../daemon/src/plugins/billing/search.ts)、[search-usage.ts](../daemon/src/plugins/gateway/search-usage.ts)、[pricing/rules.ts](../daemon/src/plugins/pricing/rules.ts)、[schema/requests.ts](../daemon/src/plugins/database/schema/requests.ts)、[0001_web_search_billing.sql](../daemon/drizzle/0001_web_search_billing.sql)。

- **请求体与观察容量**：三个推理端点的完整 JSON 请求体缺省及配置最大值均为 `32 MiB`（`33,554,432` 字节），`GATEWAY_MAX_BODY_BYTES` 的显式配置优先，可设更小的值；单个 SSE 事件与 JSON 响应用量观察各缺省 `128 MiB`、配置最大 `256 MiB`。请求体超限在入库、预占和上游转发前返回 `413 request_too_large`；观察超限后继续转发，阻止自动结算。

  依据与核对日期：`2026-10-08`，用户反馈长上下文触发 `Request body exceeds the gateway limit`，代码核对确认原缺省 `4 MiB` 会限制包含历史消息、工具定义和工具结果的完整 JSON。提高缺省至现有配置上限是项目容量约定，上游仍独立限制请求大小和模型上下文。请求完整缓存、JSON 解析及同步 Token 预估会增加大请求的内存和 CPU 开销；本次未进行容量压测。已有部署保留原 `.env` 显式值，需修改并重启进程；仅修改示例或代码回退值不会覆盖该配置。

  代码：[config.ts](../daemon/src/config.ts)：`readGatewayConfig`；[.env.example](../.env.example)；[gateway/service.ts](../daemon/src/plugins/gateway/service.ts)、[usage.ts](../daemon/src/plugins/gateway/usage.ts)。

- **超时**：请求体读取固定 `30s`；渠道缺省 `120s`，表单范围 `100–600,000ms`；渠道超时用于等待响应，SSE 收到响应后改用空闲超时，缺省 `300s`、配置最大 `3,600s`。

  代码：[gateway/service.ts](../daemon/src/plugins/gateway/service.ts)、[config.ts](../daemon/src/config.ts)、[catalog/service.ts](../daemon/src/plugins/catalog/service.ts)、[schema/catalog.ts](../daemon/src/plugins/database/schema/catalog.ts)、[Catalog.tsx](../web/src/routes/Catalog.tsx)、[.env.example](../.env.example)。

- **用户限流**：每用户并发缺省 `4`（配置最大 `100`），RPM 缺省 `60`（最大 `10,000`）；固定 `60s` 窗口，本地用户计数表最多 `10,000` 项，429 的 `retry-after` 固定 `60`。

  代码：[config.ts](../daemon/src/config.ts)、[gateway/service.ts](../daemon/src/plugins/gateway/service.ts)；这些是实例内计数。

- **模型列表与导入限额**：模型名称最长 `128`，字符集为字母、数字和 `_ . / : -`；每渠道最多 `1,000` 个模型；上游列表累计 `2 MiB`、整体超时 `20s`；每批导入最多 `100` 个模型、每模型 `1–3` 条规则。

  代码：[catalog/service.ts](../daemon/src/plugins/catalog/service.ts)、[models-dev.ts](../web/src/lib/models-dev.ts)、[channel-models.tsx](../web/src/components/channel-models.tsx)、[model-import.tsx](../web/src/components/model-import.tsx)。

- **管理入口限额**：普通 tRPC 请求 `64 KiB`，`importModels`、`saveChannel` 为 `256 KiB`；定价规则最多 `200` 条，跨午夜拆分后也受此限额约束；倍率范围 `0–1000`。

  代码：[http/index.ts](../daemon/src/plugins/http/index.ts)、[pricing/service.ts](../daemon/src/plugins/pricing/service.ts)、[pricing/rules.ts](../daemon/src/plugins/pricing/rules.ts)、[schema/catalog.ts](../daemon/src/plugins/database/schema/catalog.ts)。

- **本地 API Key 格式**：固定 `sk-` 加 `43` 个 URL-safe 字符；OpenAI 兼容端点取 Bearer，Messages 额外接受 `x-api-key`，两者同时提供时需相同。

  代码：[gateway/service.ts](../daemon/src/plugins/gateway/service.ts)：`identify`；[keys/service.ts](../daemon/src/plugins/keys/service.ts)；这是本地 Key 格式，独立于供应商 Key。

- **用量元数据限额**：仅保留非负安全整数；每对象最多前 `100` 个字段，字段名最多 `128`，嵌套深度最多 `2`；上游请求 ID 截至 `256` 字符。

  代码：[usage.ts](../daemon/src/plugins/gateway/usage.ts)：`usageNumbers`、`observe`；[gateway/service.ts](../daemon/src/plugins/gateway/service.ts)。

- **计费恢复节奏**：心跳与重试每 `15s`；每次处理最多 `50` 个内存待重试请求，连续失败 `3` 次后尝试转人工核对；数据库计费连接查询超时 `5s`。

  代码：[billing/index.ts](../daemon/src/plugins/billing/index.ts)、[billing/service.ts](../daemon/src/plugins/billing/service.ts)；长时间 agent 请求和数据库延迟变化时核对。

- **金额与计费单位**：六位小数、整数 micros；Token 单价按百万，搜索单价按千次；倍率应用后整次费用向上舍入。货币仅支持 `USD`、`CNY`，缺省 `USD`，启动仍要求与初始化数据库一致。

  代码：[conventions.ts](../daemon/src/plugins/billing/conventions.ts)、[pricing/rules.ts](../daemon/src/plugins/pricing/rules.ts)、[config.ts](../daemon/src/config.ts)、[database/bootstrap.ts](../daemon/src/plugins/database/bootstrap.ts)、[database/index.ts](../daemon/src/plugins/database/index.ts)、[schema/identity.ts](../daemon/src/plugins/database/schema/identity.ts)。

- **时区和规则语义**：固定 `Asia/Shanghai` / `+08:00`；上下文档位对整次请求定价，优先级 `combined → context → time → default`；用量缺失转 `needs_review`。钱包趋势为包含当天的七个上海自然日。

  代码：[conventions.ts](../daemon/src/plugins/billing/conventions.ts)、[pricing/rules.ts](../daemon/src/plugins/pricing/rules.ts)、[wallet/service.ts](../daemon/src/plugins/wallet/service.ts)、[Pricing.tsx](../web/src/routes/Pricing.tsx)、[schema/identity.ts](../daemon/src/plugins/database/schema/identity.ts)。

- **工具链与数据库版本**：`packageManager: pnpm@12.4.2`，engines 为 Node `>=24.13.0`、pnpm `>=12 <13`；Compose 固定 `postgres:17-alpine`。

  代码：[package.json](../package.json)、[compose.yaml](../compose.yaml)；依赖升级和 PostgreSQL 大版本迁移时核对。

- **依赖发布时间例外**：`minimumReleaseAgeExclude` 固定包含 `@fraqjs/*`、`@react-router/*`、`react-router`、`vite@8.3.3`。

  代码：[pnpm-workspace.yaml](../pnpm-workspace.yaml)；升级对应依赖时重新确认例外是否仍需要。

## 后续编辑要求

1. 修改模型、定价、工具准入、转发、usage 解析、模型导入或依赖版本前，先查对应供应商章节，再核对跨供应商规则及关联文件。agent/harness 的接入按其实际发送的协议核对。
2. 遇到价格、型号、provider 别名、协议版本或字段变化，用供应商文档、实际渠道报价或真实客户端请求确认；记录依据和核对日期，区分已核实行为与仓库自身约定。
3. 保持显式配置及 `0` 的优先级；默认值更新影响后续锁价，历史账单继续用原快照。导入预设和复制得到的已有规则需单独评估，不能假定会跟随代码自动更新。
4. 新增、调整或删除特殊适配时，在同一次修改中同步更新对应供应商条目的值、适用范围、代码入口、来源和联动点；共用行为更新到跨供应商章节。
5. 修改持久化约定或数据库约束时，使用新增迁移处理已有库，保持历史迁移和历史价格快照的含义。金额精度、数据库整数范围、加密算法和界面尺寸等常规常量不作为供应商最新规则的依据。
6. 按改动运行现有静态检查；需要验证关键转发或计费行为时遵守 `AGENTS.md` 的 e2e 与测试脚本约定。
