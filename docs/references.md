# 参考项目与致谢

本项目保留以下三个主要参考项目，分别用于界面交互、模型参数同步和定价展示。本文区分设计参考与实际改写的代码来源，不代表合作关系或原作者背书。

以下链接指向上游文件；代码改写来源记录固定提交版本。

## 1. pi-web：模型编辑体验

项目：[agegr/pi-web](https://github.com/agegr/pi-web)

参考实现：

- [ModelsConfig.tsx](https://github.com/agegr/pi-web/blob/HEAD/components/ModelsConfig.tsx)：模型编辑表单、一键填入模型信息、价格编辑和思考等级映射。
- [model-catalog.ts](https://github.com/agegr/pi-web/blob/HEAD/lib/model-catalog.ts)：Models.dev 数据转换、模型匹配与字段推荐。
- [models-config-store.ts](https://github.com/agegr/pi-web/blob/HEAD/lib/models-config-store.ts)：模型配置与价格保存。

本项目采用类似的操作流程：选择模型 → 填入信息 → 检查和编辑 → 保存。pi-web 的 models.json 存储方式不能直接用于 DSH；思考档映射也需要转换为 DSH 的 reasoningEfforts。本项目的供应商／API 地址／一致性推荐流程可补全共识参考价，未知缓存价格仍不当作零。详见 [一键推荐说明](pi-web-workflow.md)。

## 2. dsh-models-dev：参数同步与宿主接入

项目：[M4cd1r/dsh-models-dev](https://github.com/M4cd1r/dsh-models-dev)

参考实现：

- [lib/caps.mjs](https://github.com/M4cd1r/dsh-models-dev/blob/HEAD/lib/caps.mjs)：模型名称、容量、输入模态和推理档的映射与合并。
- [lib/sync.mjs](https://github.com/M4cd1r/dsh-models-dev/blob/HEAD/lib/sync.mjs)：目录获取、缓存与失败处理。
- [项目说明](https://github.com/M4cd1r/dsh-models-dev#readme)：通过 DSH Settings 接口更新模型配置、供应商来源映射和插件打包。

本项目优先处理用户已配置的模型，保留人工设置，通过预览再写入。暂不自动追加供应商完整目录，也不修改路由端点。显式 maxTokens 会影响 DSH 每次请求默认输出上限，不能只把它视为展示用容量。

## 3. dsh-model-pricing：定价来源与展示

项目：[vitas/dsh-model-pricing](https://github.com/vitas/dsh-model-pricing)

参考内容：Models.dev 与 pi-ai 目录的价格展示、来源和更新时间标注，以及供应商路由与价格的关联。

本项目第一阶段只实现四项单价的查询、编辑与保存：输入、输出、缓存读取、缓存写入。价格按供应商和模型关联，明确单位，保留未知值与人工覆盖；会话费用统计属于后续独立功能。数据库参考价不等于用户中转站的实际结算价格。

## 代码来源与开源计划

`src/core/recommend.ts` 的匹配策略基于 pi-web 的 `lib/model-catalog.ts` 改写，固定提交为 `6fcd7d44981ab51a21d6cd6eb06d361d0e3d3068`。MIT 版权与许可证已收录到随包发布的 [THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md)。其他宿主接入和价格保存代码独立实现。

本项目使用 [MIT 许可证](../LICENSE)，版权行采用 `Copyright (c) 2026 PerseusNana7mi`。

后续如复制或改写参考项目的代码，应在引入时记录源仓库、固定提交、来源文件及许可证，保留相应版权与许可声明，并在需要时新增 THIRD_PARTY_NOTICES.md。README 的致谢不替代实际引入代码所附的声明；本项目的 MIT 计划也不改变第三方代码原有许可。
