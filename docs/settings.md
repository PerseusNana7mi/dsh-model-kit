# Settings 接入与价格持久化

## 版本及数据位置

目标为 DSH `0.2.0-rc.2`。官方 Settings 从 Loader 的 Config schema 提取 `.volatile()` 字段，通过配置编辑器写入当前 profile 的 `cordis.patch.yml`。旧 `settings.yaml` 属于宿主的迁移输入，本插件不操作它。

- 模型配置：默认命名空间 `llm-pi-ai`，通过普通配置 `modelNamespace` 可指定该适配器另一实例的 entry id。
- 价格配置：本插件实际 Loader entry id（默认 `model-metadata`）下的 `prices` 可变字段。
- 参考映射：同一插件 entry 下的 `sourceMappings` 可变字段，独立于价格与倍率快照。

- 每条价格以 `[模型命名空间, provider, modelId]` 的 JSON 字符串为键，避免点号和斜杠产生歧义。
- 读取通过 `describe({ redactSecrets: true })`，写入通过 `mutate(ns, ops, expectedRevision)`。

来源：[Settings 官方说明](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.0-rc.2/packages/settings/settings/README.md)、[Settings 实现](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.0-rc.2/packages/settings/settings/src/index.ts)。

## 插件配置

| 字段 | 默认值 | 用途 |
| --- | --- | --- |
| `catalogUrl` | `https://models.dev/api.json` | 参数目录；必须为不含 URL 凭据的 HTTPS 地址 |
| `timeoutMs` | `15000` | 网络与模型发现超时，毫秒 |
| `cacheTtlMs` | `86400000` | 内存目录缓存有效期，毫秒；0 表示每次重新获取 |
| `modelNamespace` | `llm-pi-ai` | 模型适配器 Settings 命名空间 |
| `prices` | `{}` | 本插件保存的价格记录，通常通过面板管理 |
| `sourceMappings` | `{}` | 用户明确确认的精确价格参考映射，通常通过面板管理 |

启动不自动同步。目录失败明确返回错误，不回退过期缓存；价格快照在保存后不随目录变化。完整 schema 以 `src/index.ts` 和 `src/pricing-schema.ts` 为准。

## 宿主服务 API

宿主调用方注入 `modelMetadata`。客户端使用 `modelMetadataUi.execute`；请求为 schema 严格校验的 action 联合，只开放列表、读取、预览和指定保存操作，不允许透传任意设置路径。

| 方法 | 用途 |
| --- | --- |
| `readModel(provider, id)` | 返回可编辑模型字段和模型命名空间 revision |
| `previewConfigured(provider, id, catalogProvider?)` | 基于当前配置做 Models.dev 补全预览，并返回原始 revision；不写入 |
| `saveModel(provider, id, patch, expectedRevision, acceptDefaultOutputCap?, allowPresetOverride?)` | 保存指定字段；更改 maxTokens 需确认默认上限，受保护预设还需本次允许 |
| `readPrices(provider, id)` | 返回价格记录和插件命名空间 revision；不存在的记录为 undefined |
| `savePrices(provider, id, values, expectedRevision, currency?)` | 人工修改指定单价，省略的单价保持原样 |
| `fillPrices(provider, id, expectedRevision, catalogProvider?, currency?, pricingSource?)` | 从精确匹配的目录条目补齐缺失单价，保留所有已存单价 |
| `setPriceMultiplier(provider, id, referenceProvider, referenceModel, multiplier, expectedRevision, currency?, pricingSource?, quoteTicket?, reuseSavedReference?)` | 保存指定参考模型价格快照，启用倍率模式 |
| `useManualPrices(provider, id, expectedRevision)` | 切回已保存的直接单价，不丢弃倍率参考快照 |

`fillPrices` 补全的是保留的直接单价表，不会自动取消倍率模式。返回的 `effect` 为 `applied`（直接单价已生效）、`stored-inactive`（已补全备用直接单价，当前倍率与生效价保持）或 `unchanged`（没有缺失单价可补）。客户端 `action: 'fill'` 在 `fillResult` 中返回 `changed` 与 `effect`。需要使用补全单价时，显式调用 `useManualPrices` / `manualMode`；需要更新倍率基价时，重新获取参考报价并保存倍率。

## 手动价格与倍率模式

面板提供两个选项：**手动单价**、**参考价 × 倍率**。宿主 API、持久化与浏览器编辑控件已经实现。

- 手动模式分别填写输入、输出、缓存读取、缓存写入单价；`savePrices` 写入非空手动单价后切回此模式。已有目录补全单价也可以作为直接单价编辑。
- 倍率模式明确指定参考供应商和模型 ID，例如模型开发商在 Models.dev 中的条目。不能仅凭中转站模型名称断言来源为官方。界面已支持供应商、API 地址及多来源一致性推荐；自动结果不是官方价格认证。
- `effective = referencePrice × multiplier`，一个倍率统一作用于四项单价。0.5 表示五折，2 表示两倍；允许 0，拒绝负数、非有限值及计算溢出。
- 参考价与倍率分开保存，反复读取不会重复乘算。未知缓存单价即使倍率为 0 仍保持未知。
- 倍率启用时必须有输入和输出参考价。原手动价格保留；切回手动模式恢复它们，不用倍率结果覆盖。
- `readPrices` 返回 `record`（配置及来源）、`effective`（实际采用的单价）和 `revision`。后续费用统计必须消费 `effective`。
- 参考价格为快照；目录刷新不会自动改变已保存倍率基价。界面保存使用已预览报价，重新获取参考单价后再保存才更新基价。宿主直接调用 `setPriceMultiplier` 默认仍获取目录参考价；显式传入 `quoteTicket` 使用预览快照，`reuseSavedReference: true` 使用已保存快照。
- 保存直接单价不会用旧倍率参考覆盖当前新报价；只编辑模型参数时不发送价格写入。主动重新读取恢复已保存的参考快照，未保存票据仍受有效期约束。

例如参考输入 $3、输出 $15，倍率 0.5 时生效价为 $1.5、$7.5 / 百万 tokens。该值是用户设定的估算费率，不代表中转站账单。

`catalogProvider` 允许用户显式选择自定义网关对应的数据源；这只是来源映射，不代表网关实际账单价格相同。模型 ID 不做模糊回退。

模型字段白名单为 name、contextWindow、maxTokens、input、reasoningEfforts；不允许通过这个 API 改路由、凭据、ID 或注入 cost。数值、协议及模型可用性最终由宿主适配器 schema 和配置钩子校验。

新写入的 name 最多 512 字符，单个推理请求值最多 128 字符；直接单价、原生参考单价和倍率计算后的单价上限均为 1,000,000,000／百万 tokens，仍允许零与小数。请求限制与读取 schema 分开，历史超限记录可读取后修正；宿主直接调用保存方法也执行写入限制。

## 保存规则

- `saveModel` 处理显式 models 数组，要求模型 ID 唯一；继承内置目录由 `overrides.read/write` 按字段处理，不替换完整目录。
- 使用完整 revision 防止旧预览覆盖新配置，发生冲突要求重读，不自动重试覆盖。
- 模型写入替换单个供应商的 models 数组，保留其他模型和未编辑字段；不重建整个供应商配置。如果模型数组内有脱敏字段，拒绝替换。
- 价格保存 USD 或 CNY / 百万 tokens，分别记录数值、manual/catalog 来源、更新时间。目录来源附 URL、来源 provider、model、获取时间。
- 目录补全不覆盖已有价格，包括人工设置的 0。缺失缓存价格保持缺失。
- 模型与价格属于不同命名空间，两次保存不是跨命名空间事务。当前 UI 分别处理结果，参数已保存但价格失败时明确提示并保留价格草稿。
- 没有定时同步、自动写回或上游模型测活；只在显式服务调用时写入。

## 验证范围

`pricePreview` 返回宿主保管的报价 ticket，有效期 30 分钟，最多保留最近 128 份。`priceDraft` 将手动编辑的 `values` 与逐字段报价 ticket `quotes` 在一次 Settings mutation 中保存；同一字段不能同时出现在两处。报价的币种、模型、有效期和 revision 校验通过后才写入。来源 URL、供应商、模型、获取时间由宿主快照提供，不接受客户端自行声明来源。过期或宿主重启后的待保存报价需要重新获取；已保存单价和来源不受影响。

界面仅提交实际修改的手动单价，保留未编辑字段的 catalog 来源。倍率草稿使用独立参考报价，切回手动模式恢复原直接单价。切换模型或重新读取会使旧参数查询失效；价格查询另有目标、币种、数据源和请求序号检查。单一精确匹配来源也提供逐字段冲突比较。

集成测试创建工作区内临时 profile，运行实际 DSH boot、Loader、Settings 与 ConfigEditor，写入真实 patch 文件，再启动新 Context 读取恢复值。覆盖旧 revision、竞争写入、人工零价、未知价格、参数校验，以及路由秘密字段和其他模型的保留。

测试中的 LLM 适配器使用有限字段 schema fixture，目录网络使用固定响应；没有连接真实模型或读取用户凭据。UI 另有真实浏览器、模拟调用响应的测试。这些自动化测试不覆盖完整 llm-pi-ai 协议边界、其他宿主版本或真实模型调用。

## 其他远程操作

### 已确认的价格参考映射

键为 `[modelNamespace, provider, modelId, pricingSource, currency]` 的 JSON 字符串；记录参考供应商／模型 ID、数据源、币种、目录地址、确认时间和协议／API 地址的 SHA-256 指纹，不保存路由原文、headers 或凭据。最多保存 2,000 条，达到上限可替换已有项或先清除。路由或目录地址变化时拒绝按映射获取，损坏记录可替换／清除；删除目标后也可通过受限清除 API 删除对应记录。目录内容有效性在主动获取时重新检查，不启动后台检查。

`read` 以及单模型保存响应中的 `sourceMappings` 返回插件 revision、模型 revision、writable 和当前目标的各币种／数据源映射；省略原始目录 URL 和路由指纹，状态为 `ready`、`route-changed`、`catalog-changed` 或 `invalid`。`ready` 不表示来源条目已联网验证。

- `mappingSave`：目标、数据源、币种、两份 revision、`confirmed: true` 和有效 `quoteTicket`。报价必须由宿主获取，绑定当前目标供应商、模型、模型 revision、数据源和币种；不接受客户端直接声明参考身份或来源。共识、无目标供应商绑定的旧式报价、过期票据、变化后的模型 revision 均拒绝。`pricePreview` 新增可选 `targetProvider` 与已有 `targetId` 一起绑定目标；自动推荐报价也携带内部目标绑定。
- `mappingUse`：目标、数据源、币种和两份 revision；强制获取映射中的精确参考条目新报价，下载后再次检查两份 revision。失败不回退缓存或其他候选，也不写配置。返回 `priceQuote`，仍需走原有保存确认。
- `mappingClear`：目标、数据源、币种和插件 revision，仅删除指定映射，不删除价格。

映射保存在插件实际 Loader entry，写入仅使用官方 Settings 的单条 set／unset。保存和清除后，仅在返回版本可确认为自身操作且完整价格表未变化时，响应包含 `priceRevisionFrom`；客户端只更新仍基于该原始版本的价格草稿 revision，不采用外部新价格版本。当前实现针对显式模型的价格参考；不会改变自动推荐、参数来源、批量来源或保存后的倍率基价，也不证明供应商结算方式。

### 批量核对与确认保存

`action: 'batchReview'` 接收 `targets: [{ provider, id }]`、`currency`（默认 USD）及 `pricingSource`（默认 models.dev），目标限 1～100 个且不可重复。目标是当前适配器命名空间中的显式模型，不允许传入任意配置路径、保存字段或客户端报价。Models.dev 不接受 CNY。宿主服务对应 `batchReview(targets, currency?, pricingSource?)`，直接调用也执行请求限制。

返回 `batchReview`，包含核对时间、模型与价格命名空间 revision、目录失败警告和逐模型结果，以及宿主管理的 `ticket`、`expiresAt` 和 `writable`。`parameters` 沿用字段差异格式，`selected` 表示默认补全；`priceChanges` 包含当前／建议生效价和补全标记。`currentPrices` 为已保存生效价，`referencePrices` 为本次目录参考价；倍率模型另有 `savedReferencePrices` 和 `referenceUpdateAvailable`，后者只允许完整的同来源快照更新。报价、字段值和来源由宿主保存，不接受客户端重述。

模型与价格通过一次脱敏 `describe` 生成配置快照；每批刷新所需目录一次，复用进行中的请求，不采用失败后的过期目录。参数与 basellm 价格独立失败；逐模型错误不隐藏其他结果。下载后再次检查两份 revision；变化则拒绝整批预览。整个操作不调用 `mutate`，只读 Settings 也可核对。

补全标记保护已有人工值和明确零价，保留单模型能力补全例外。更新模式由客户端展示全部可用差异，不代表授权覆盖。倍率模型仅复用同币种、同来源、精确参考模型和原倍率进行试算，历史共识参考、来源不一致、未知参考项或超限计算不生成对应更新建议；目录缺失项不删除保存值。异币种记录跳过价格比较。

`action: 'batchCommit'`（宿主 `batchCommit(request)`）接收 `ticket`、`confirmed: true`、`mode: 'fill' | 'update'`、1～100 个不重复的 `selections` 和两项确认 `acceptDefaultOutputCap`／`allowPresetOverride`。每项选择只能包含预览内的 `provider`、`id`、`fields`（模型字段名）、`prices`（四项直接单价字段名）及 `updateReference`（是否更新整份倍率参考）；不接收任意路径、字段值、币种、倍率或报价来源。补全模式拒绝选择非补全建议；更新模式也只能选择本计划已有建议。

保存计划有效期 15 分钟，宿主最多保留 20 份；容量不足淘汰最旧的非繁忙计划，过期、重启或插件重载后不可提交。同一票据禁止并发保存。提交先完整检查目标、重复项、字段白名单、新写入限制、两份原始 revision、脱敏数组、预设授权和输出上限确认，然后参数／价格各最多一次 `mutate`，不承诺跨命名空间事务。每个供应商只替换其一次合并后的 models 数组，保留其他模型、compat 和未编辑字段；每条直接单价仅修改选中项目并写入宿主保管的 catalog 来源。

倍率模型只接受更新模式下的 `updateReference: true`，不能同时选择 `prices`；新快照必须包含旧快照所有已知字段，整份替换后仍保留倍率和备用手动价。零倍率不阻止显式更新基价；缺项不会通过合并旧字段而伪装成新来源。历史共识参考仍需单模型核对。

返回 `batchSaved`：`models`／`prices` 各为 `saved`、`skipped`、`pending` 或 `failed`，同时给出 `complete`、`retryable` 和说明。参数写入失败时不开始价格写入。参数成功后核对写入结果与预期快照，再保存价格，继续使用原价格 revision；不以模型写入返回的新状态替换它。部分失败后，模式与选择组合锁定；只有原计划仍有效、未完成命名空间的 revision 未变化，以及已写参数状态可确认时才允许按原报价重试。成功结果在有效期内保留，同一选择重复提交返回原回执。外部修改或结果不确定时拒绝自动重试，要求重新预览；宿主适配器 schema 和钩子的最终校验仍在真实写入时执行。

### 现有操作

操作的完整字段、默认值和严格校验以 `src/wire.ts` 为准；服务实现位于 `src/index.ts`、`src/integration/`。以下 action 不接收任意配置路径：

- `list` / `read` / `routes`：已配置模型、快照及宿主供应商目录。
- `recommend` / `candidates` / `preview`：自动推荐、精确候选和配置参数预览。
- `discover` / `importPreview` / `importCommit`：发现、宿主保管的导入计划及确认追加。
- `builtinList` / `builtinRead` / `builtinWrite`：继承目录的模型与字段覆盖。
- `pricePreview` / `priceDraft` / `manual` / `fill` / `multiplier` / `manualMode`：价格查询、草稿、补全与模式切换。
- `model`：显式模型字段保存。

导入会话有效期 15 分钟，单次最多选择 500 个模型。每次发现只处理上游前 2,000 项并报告截断，限制每个会话的模型列表体积。完成发现后会淘汰旧会话，将共享会话表控制在 20 条以内；计划可增加到 40 条，达到上限时淘汰最旧导入计划，为新预览腾出空间，已淘汰票据不能再保存，过期计划会清理。票据与 revision 共同防止旧计划写入。

显式 recommend 请求可传 forceRefresh: true，绕过目录缓存；Models.dev 与 basellm 的所有目录响应均限制为 32 MiB 解码后字节，批量目录并发刷新复用请求。倍率票据与手动单价票据一样校验目标模型。模型与价格独立维护 revision，前端不会用模型保存响应中的最新价格 revision 替换旧价格草稿版本。

选择 basellm 时，Models.dev 参数查询失败不会阻止原生价格查询；返回可选的 metadataMessage 解释参数失败，priceMessage 单独解释价格结果。参数刷新失败时不采用过期参数缓存，查询结果不会自动写入配置。
