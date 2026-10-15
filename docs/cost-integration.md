# DSH 费用接口核查与实施计划

基线：DSH `dsh-v0.2.0-rc.2`。这些结论针对固定版本，宿主升级后应重新核查。

当前插件保存和展示四项 token 单价，不计算按实际用量产生的费用，也不修改供应商账单。以下为已核查的候选接口与尚未实现的计划，不代表完成了真实 Desktop 计价验收，也不绑定版本或交付时间。整体优先级见 [开发指南后续版本待办](development.md#后续版本待办)。

## 当前宿主接口

- [TurnUsagePanel](https://github.com/deepseek-ai/DeepSeek-Harness/blob/dsh-v0.2.0-rc.2/packages/client/ui-chat/src/client/chat/TurnUsagePanel.tsx) 展示 token、缓存命中率和路由，没有货币费用字段。
- [TurnTokenUsage](https://github.com/deepseek-ai/DeepSeek-Harness/blob/dsh-v0.2.0-rc.2/packages/llm/token-meter/src/turn-usage.ts) 是跨请求聚合，不能直接用于混合路由、分时或阶梯计费。
- [pi-ai catalog](https://github.com/deepseek-ai/DeepSeek-Harness/blob/dsh-v0.2.0-rc.2/packages/llm/llm-pi-ai/src/catalog.ts) 说明 Harness 不消费其 cost 元数据。
- `route-pricing` / `request-pricing` 中的 pricing 涉及图片请求 token 折算，不是人民币或美元金额。

以下接口提供独立估算的可行性依据，需通过原型确认监听作用域、实际适配器行为和产品覆盖范围：

| 接口 | 可用于 | 尚未解决的边界 |
| --- | --- | --- |
| [llm/stream waterfall](https://github.com/deepseek-ai/DeepSeek-Harness/blob/dsh-v0.2.0-rc.2/packages/llm/llm/src/index.ts) | 观察单次调用的 provider、model 与 usage，并原样透传流 | 监听顺序与作用域、插件卸载、取消及异常；不能让计量故障打断聊天，也不能吞掉原始模型错误 |
| [GenerateOptions、StreamChunk 与 TokenUsage](https://github.com/deepseek-ai/DeepSeek-Harness/blob/dsh-v0.2.0-rc.2/packages/llm/llm/src/types.ts) | 路由、可选 sessionId、辅助调用 purpose 与单次用量 | sessionId 是可选会话身份；进程内 isAgentLoopRequest 只判断请求来源，二者均不是可持久去重的请求唯一标识；usage 也可能缺失 |
| [会话事件](https://github.com/deepseek-ai/DeepSeek-Harness/blob/dsh-v0.2.0-rc.2/packages/core/session/src/types.ts) | seq、time、turn／step、assistant/message 及 assistant/attempt 中的流记录 | 失败尝试可能保留 usage，但归属信息与完整性需验证；辅助调用未必都能从普通聊天日志重建 |
| [SessionPersistence](https://github.com/deepseek-ai/DeepSeek-Harness/blob/dsh-v0.2.0-rc.2/packages/session/session-persistence/src/index.ts) 与 [只读 SessionHandle](https://github.com/deepseek-ai/DeepSeek-Harness/blob/dsh-v0.2.0-rc.2/packages/session/session-persistence/src/handle.ts) | 通过宿主服务读取持久事件，按需分析历史 | 需要对应宿主服务及依赖契约，处理日志完整性、分支继承与读取成本；历史日志没有自动附带插件当时的价格 |
| [聊天 turnTail 扩展槽](https://github.com/deepseek-ai/DeepSeek-Harness/blob/dsh-v0.2.0-rc.2/packages/client/ui-chat/src/client/contract/slots.ts) | 研究独立的轮次费用入口 | 不代表原生用量弹层开放费用字段，也不保证现有依赖即可完成接入 |

原生费用弹层接入继续单独评估，独立估算无需整体等待原生货币字段。[现有远程事件白名单](https://github.com/deepseek-ai/DeepSeek-Harness/blob/dsh-v0.2.0-rc.2/packages/api/remotes/src/remote-events.ts) 没有现成费用推送事件，但不意味着界面不能更新。可先通过插件远程读取，按已开放的活动事件触发刷新或在面板可见时低频轮询；限制并发，清理订阅及定时器，不为每个 token 刷新界面。

## 固定 token 单价的计算口径

计算消费已保存记录的 `effective`，避免漏乘或重复乘倍率。四项单价均为所选币种／百万 tokens：

```text
费用 = (未缓存输入 tokens × 输入单价
      + 缓存读取 tokens × 缓存读取单价
      + 缓存写入 tokens × 缓存写入单价
      + 输出 tokens × 输出单价) / 1,000,000
```

- DSH 的 inputTokens 为未缓存输入，与缓存读写分开，不从中重复扣除缓存。
- reasoningTokens 按宿主轮次统计作为输出子集处理，同一输出费率下不再叠加。独立推理收费仍属于未支持的复杂定价，不能套用该公式。
- 仅在用量和适用费率足以确定时计算对应项目；明确零用量的项目贡献为零，缺失用量不能当零。存在无法确定的项目时显示“已知部分合计／统计不完整”和缺失原因，不冒充完整总价。
- 不从上下文压力估计量推导供应商账单。图片 usage 是否已包含视觉 token 必须按适配器及供应商验证，不能因存在图片 token 折算接口就断言费用偏低或再追加一次费用。
- 缺少可靠固定价时可显示无法估算；用户明确填写固定估算价后，结果继续标为估算，不能称为复杂计费的精确结算。
- 金额显示时统一舍入，累计保留计算精度并检查有限值与范围，避免逐次显示舍入造成累计偏差。

口径证据见 [TokenUsage 定义](https://github.com/deepseek-ai/DeepSeek-Harness/blob/dsh-v0.2.0-rc.2/packages/llm/llm/src/types.ts) 和 [轮次用量归一化实现](https://github.com/deepseek-ai/DeepSeek-Harness/blob/dsh-v0.2.0-rc.2/packages/llm/token-meter/src/turn-usage.ts)。实际供应商适配器仍需通过响应样本验收。

## 从首版起保留的记录与约束

| 项目 | 约定 |
| --- | --- |
| 调用身份 | 区分会话、轮次、步骤与每次尝试；为在线记录设计独立身份及日志关联规则，不用 sessionId 作为请求去重键。不能关联的调用单列并说明范围 |
| 模型身份 | 将实际 provider／model 可靠映射到定价命名空间；不支持或无法映射的路由标记为无价格，不猜测同名模型。首版先限制到已验证适配器与路由 |
| 价格快照 | 从第一次自动统计起保存当次四项生效费率、币种、单位、来源与选价时间；updatedAt／fetchedAt 不能替代不可变价格快照。改价后保留原结果，按新价试算使用独立操作 |
| 用量与结果 | 保留观察到的计数、完成／失败／取消状态、完整性及缺失原因。有 usage 的失败尝试可以估算，缺 usage 的失败不能当免费；流的 usage 按宿主协议处理，不反复累计同一快照 |
| 币种 | USD 与 CNY 分组显示和汇总，首版不自动换汇，不跨币种相加 |
| 覆盖范围 | 区分普通对话、压缩与标题等辅助调用；明确是否包含子代理，无法归属的调用单列。一次成功回复不等于只产生一次模型调用 |
| 分支与恢复 | 分支继承的历史不重复计入新增消费；父子代理汇总区分直接消费与包含子调用的消费。处理重连、重启、插件重载及日志回放去重 |
| 持久化 | 配置只存价格规则与开关，运行记录使用独立存储；不逐请求重写 cordis.patch.yml。限制队列与存储体积，定义保留、清除、恢复和导出；只保留必要计量信息，不额外复制聊天正文或凭据 |
| 故障隔离 | 流内不等待记账 I/O；计量、持久化及展示失败不得中断真实请求。保留原始异常、取消与迭代器关闭语义，不能用宽泛 catch 把真实模型错误吞成成功 |

## 分阶段实施

1. **费用试算器**：手动输入假设用量，读取已保存生效价，比较模型与倍率；独立可用，不要求自动采集。参考价偏差只是配置价比较，不能用于认定供应商多收费。
2. **宿主原型与新请求估算**：先验证真实 Desktop 的流捕获、归属、辅助调用和重试；支持已验证路由的固定 token 价格，提供独立明细，从开始保留费率快照与完整性。若实验阶段只保留内存记录，明确提示重启清空及统计起点，不声称为持久账本。
3. **持久统计与历史回算**：完成独立存储及去重后，增加轮次／会话／日期／模型统计和导出。旧日志没有当时价格时，仅提供“按当前／指定价格回算”；有用量不等于有历史价格，不自动改写已有估算结果。按需分页读取事件并缓存派生结果，避免启动扫描全部会话。
4. **提醒与复杂规则**：在数据稳定后增加预算提醒及独立聊天入口；提醒不能保证供应商侧绝不超支。分时、上下文阶梯、缓存写入档位、音视频和按次等规则单独设计条件、版本与迁移，不静默压成固定价；订阅额度与实际账单核对另行评估。

首个自动计价版本的验收至少覆盖：未缓存／缓存／推理子集、未知与明确零、倍率、改价期间请求、混合路由、失败重试、辅助调用、分支去重、USD／CNY 隔离、取消与卸载、存储失败不影响聊天。统计与存储模块可在插件内保持独立，规模或宿主依赖面扩大后再评估拆包。
