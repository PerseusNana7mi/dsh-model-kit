# 原币种价格与预设保护

价格来源可选 Models.dev（USD）及 [basellm/llm-metadata](https://github.com/basellm/llm-metadata)（USD / CNY）。后者为运行时数据来源，不增加 docs/references.md 的三个设计参考项目。未复制其实现代码；该项目标注 Apache-2.0，本项目使用 MIT 许可证。

显式来源接口为 `https://basellm.github.io/llm-metadata/api/providers/<provider>.json`；一键推荐读取 `https://basellm.github.io/llm-metadata/api/all.json` 并按所选币种匹配。仅用户点击获取或保存倍率时请求，不启动自动同步。按参考供应商与模型 ID 精确匹配，保存来源 URL、模型 ID 和获取时间。不会发送用户 API Key。

`cost.currency` 未声明时按 USD 解释；CNY 必须来自明确的 `cost.currency: CNY` 或独立的 `cost.currency_options.CNY`，不以供应商币种推断所有数值。币种是计价单位，不是显示换算；换币种保存时丢弃旧币种各项单价与不相容的参考快照，缺失保持未知。没有自动汇率换算。

当前仅支持四项固定 token 单价。发现分时价、阶梯价、独立推理价格或音视频等附加价格时拒绝自动填价，用户可核对来源后手动填写固定估算价。DeepSeek 的分时价因此不会被静默压平成谷时价。订阅套餐的零 token 价不导入。Models.dev 价格同样进行复杂计费检查。

模型参数仍从 Models.dev 补全。默认使用 Models.dev 的 USD 参考价，切换 CNY 时默认使用 basellm 原生人民币价，供应商自动匹配，数据源可在“编辑价格”中调整。价格只写插件 Settings，不改 DSH 内置费用统计或平台账单。

## 预设保护范围

原生 llm-deepseek / llm-deepseek-account 不在默认 llm-pi-ai 编辑范围。llm-pi-ai 的继承目录通过 modelOverrides 单独编辑，不创建替换列表；内置供应商空 models 数组同样视作继承。

导入使用宿主供应商目录的 declared 标志识别预设；原有模型编辑也加入宿主目录检查，并保留 DeepSeek、OpenCode 等已知路由及缺少 api/baseURL 时的保守保护。界面勾选“允许覆盖”仅对本次保存有效，后端再次校验；价格可独立编辑。未被宿主标明为自定义供应商的路由默认保护。保存保留其他模型、compat 与凭证。

## 验证边界

自动化覆盖币种隔离、复杂价格拒绝、后端预设锁、手动与倍率切换，以及 Settings 的保存和重启。

## 直接单价与倍率

生效价为直接单价，或已保存参考价快照乘倍率。切回手动模式会恢复同币种直接单价；未知缓存价即使乘以零仍然未知。一个模型记录只保存当前币种，换币种不会把旧币种数值换算成新币种。

高级服务接口 `fillPrices` 在倍率模式下仅补全备用直接单价，返回 `stored-inactive`，不自动停用倍率。普通面板的价格草稿保存与该接口不同，完整约定见 [Settings 文档](settings.md)。
