# DSH 费用统计接口核查

基线：DSH `dsh-v0.2.0-rc.2`。这些结论针对固定版本，宿主升级后应重新核查。

当前插件保存和展示四项 token 单价，不计算按实际用量产生的费用，也不修改供应商账单。

## 当前宿主接口

- [TurnUsagePanel](https://github.com/deepseek-ai/DeepSeek-Harness/blob/dsh-v0.2.0-rc.2/packages/client/ui-chat/src/client/chat/TurnUsagePanel.tsx) 展示 token、缓存命中率和路由，没有货币费用字段。
- [TurnTokenUsage](https://github.com/deepseek-ai/DeepSeek-Harness/blob/dsh-v0.2.0-rc.2/packages/llm/token-meter/src/turn-usage.ts) 是跨请求聚合，不能直接用于混合路由、分时或阶梯计费。
- [pi-ai catalog](https://github.com/deepseek-ai/DeepSeek-Harness/blob/dsh-v0.2.0-rc.2/packages/llm/llm-pi-ai/src/catalog.ts) 说明 Harness 不消费其 cost 元数据。
- `route-pricing` / `request-pricing` 中的 pricing 涉及图片请求 token 折算，不是人民币或美元金额。

聊天扩展槽允许贡献轮次内容，不代表原生用量弹层已开放费用字段。等待宿主提供合适接口后再评估原生统计接入。

## 后续估算所需证据

独立估算面板需要逐请求用量、供应商和模型、请求时间、稳定标识及适用价格版本；不能用整轮聚合量简单乘一个单价。还需处理缓存、重试、混合路由、币种和复杂价格规则。

本页不是已实现功能声明。
