# Settings 接入与价格持久化

## 版本及数据位置

目标为 DSH `0.2.0-rc.2`。官方 Settings 从 Loader 的 Config schema 提取 `.volatile()` 字段，通过配置编辑器写入当前 profile 的 `cordis.patch.yml`。旧 `settings.yaml` 属于宿主的迁移输入，本插件不操作它。

- 模型配置：默认命名空间 `llm-pi-ai`，通过普通配置 `modelNamespace` 可指定该适配器另一实例的 entry id。
- 价格配置：本插件实际 Loader entry id（默认 `model-metadata`）下的 `prices` 可变字段。

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

例如参考输入 $3、输出 $15，倍率 0.5 时生效价为 $1.5、$7.5 / 百万 tokens。该值是用户设定的估算费率，不代表中转站账单。

`catalogProvider` 允许用户显式选择自定义网关对应的数据源；这只是来源映射，不代表网关实际账单价格相同。模型 ID 不做模糊回退。

模型字段白名单为 name、contextWindow、maxTokens、input、reasoningEfforts；不允许通过这个 API 改路由、凭据、ID 或注入 cost。数值、协议及模型可用性最终由宿主适配器 schema 和配置钩子校验。

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

操作的完整字段、默认值和严格校验以 `src/wire.ts` 为准；服务实现位于 `src/index.ts`、`src/integration/`。以下 action 不接收任意配置路径：

- `list` / `read` / `routes`：已配置模型、快照及宿主供应商目录。
- `recommend` / `candidates` / `preview`：自动推荐、精确候选和配置参数预览。
- `discover` / `importPreview` / `importCommit`：发现、宿主保管的导入计划及确认追加。
- `builtinList` / `builtinRead` / `builtinWrite`：继承目录的模型与字段覆盖。
- `pricePreview` / `priceDraft` / `manual` / `fill` / `multiplier` / `manualMode`：价格查询、草稿、补全与模式切换。
- `model`：显式模型字段保存。

导入会话有效期 15 分钟，单次最多选择 500 个模型。完成发现后会淘汰旧会话，将共享会话表控制在 20 条以内；计划可增加到 40 条，达到上限时提示重新获取模型，过期计划会清理。票据与 revision 共同防止旧计划写入。
