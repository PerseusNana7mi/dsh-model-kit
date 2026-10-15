# 开发指南

## 环境与命令

- Node.js ≥ 22.19；开发测试依赖锁定 DSH `0.2.0-rc.2`，对外 peer 使用下述兼容范围；Cordis 与 Schemastery 使用各自独立版本。
- 使用 `package-lock.json` 安装依赖；锁文件下载地址使用 npm 官方 registry。
- 浏览器脚本当前使用本机 Microsoft Edge 的 headless 通道，需要已安装 Edge；`npm ci` 不会安装 Edge。

```sh
npm ci
npm run verify
npm run test:ui
npm pack
```

| 命令 | 行为 |
| --- | --- |
| `npm run lint` | 检查源码 Promise 处理及 React Hook 规则 |
| `npm run format:check` | 校验源码、脚本和测试的统一格式；format 命令可修正 |
| `npm run typecheck` | 通过 tsconfig.test.json 检查源码与 TSX fixture，不输出文件 |
| `npm run build` | tsc 生成 lib，esbuild 生成压缩的 DSH 客户端入口 |
| `npm test` | 先构建，再测试 lib 中的实际产物 |
| `npm run verify` | lint、格式、类型检查、构建测试、打包文件预检查；只构建一次 lib，pack 预检查跳过生命周期脚本 |
| `npm run test:ui` | 五组浏览器脚本，部分截图写入 work |
| `npm pack` | prepack 先构建，仅生成本地 tgz，不等同于 `npm publish` |

日常使用标准测试命令，不在修改源码后直接测试旧 `lib`。浏览器 fixture 测试不能替代真实 Desktop 验收。GitHub Actions 在 Windows runner 上使用 Node 22.19.0，执行 `npm ci`、`npm run verify` 和五组 Edge 浏览器测试。

## 宿主版本兼容策略

所有 DSH peer 与声明性的 `engines.dsh` 使用 `^0.2.0-rc.2 || ^0.2.1-alpha.1`，接受 rc.2 起的同基版本预发布、`0.2.1-alpha.1` 起的同基版本预发布及后续 `0.2.x` 正式版；不接受 `0.3.0` 及其预发布。当前安装兼容检查以 peer 为准，`engines.dsh` 只供元数据阅读。Cordis 使用 `~4.0.4`，Loader 使用 `~1.0.5`，允许各自补丁更新；React 保持 `^18.3.1`。

DSH rc.2 的 [官方兼容检查器](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.0-rc.2/packages/boot/app-boot/src/plugin-compatibility.ts) 使用 `includePrerelease: true`，因此上述范围还允许后续 `0.2.x` 的预发布进入加载检查。npm 默认规则不同：每个新补丁版本的预发布需要显式加入范围；例如未来 `0.2.2-alpha.1` 会通过当前 DSH 检查，但不满足 npm 默认 peer 判断。后续支持此类版本时，应核对接口、补充范围并回归测试，不依赖用户强制安装或版本豁免。

`devDependencies` 与锁文件中的实际宿主版本继续固定在 rc.2，避免扩大 peer 范围同时改变开发基线。`test/peer-compatibility.test.mjs` 调用真实 `evaluatePluginCompatibility`，并按 npm 默认 SemVer 规则检查已声明版本及范围边界。允许加载不等于已经完成对应版本的运行验证；当前集成测试使用 rc.2。升级到 DSH 0.3 系列前需重新评估接口并更新范围。

## 目录职责

| 路径 | 职责 |
| --- | --- |
| `src/core/` | 目录转换、候选匹配、字段差异与原币种价格校验 |
| `src/index.ts` | Cordis 服务、按需网络请求、目录缓存与报价快照 |
| `src/integration/` | Settings 写入、导入预览和内置覆盖 |
| `src/wire.ts` / `src/controller.ts` | 前后端共享 schema 与受限远程操作 |
| `src/client/` | 设置页、模型与价格草稿、列表及交互；model-draft 和 override-draft 提供草稿转换 |
| `src/pricing-schema.ts` | Settings 价格持久化 schema |
| `src/package-identity.ts` | 公共包标识；内部服务和配置 ID 保持兼容 |
| `test/` / `scripts/` | 逻辑与宿主集成测试、浏览器 fixture、构建和验证脚本 |
| `docs/` | 用户说明、开发契约与参考资料 |


## 宿主接入约定

- 模型和价格写入经过官方 Settings `mutate` 及 revision 检查；不直接重写用户配置文件。
- 内置继承目录按字段写入 `modelOverrides`，不替换完整目录；凭据不进入客户端响应。
- 客户端使用 `settings.section` 注册独立设置页，远程 namespace 在注入作用域内访问。
- Typert 描述使用当前版本的 `codec.create`。资源注册与事件监听必须随 Cordis 生命周期清理。
- React 和共享宿主服务使用 peer + dev dependencies；不要让插件引入另一份服务实例。
- 客户端产物注册 DSH 模块工厂；`./client` 使用宿主识别的 default 导出。Zod 在浏览器包内，尚未迁移 Zod Mini。
- 模型配置仍归适配器，价格存插件 `prices`；不向宿主模型注入未经支持的 cost 字段。

固定基线资料：[发布与加载](https://github.com/deepseek-ai/DeepSeek-Harness/blob/dsh-v0.2.0-rc.2/docs/user/develop/basic/publish.md)、[配置](https://github.com/deepseek-ai/DeepSeek-Harness/blob/dsh-v0.2.0-rc.2/docs/user/develop/basic/config.md)、[服务](https://github.com/deepseek-ai/DeepSeek-Harness/blob/dsh-v0.2.0-rc.2/docs/user/develop/framework/service.md)。

## 文档维护

1. README 只保留用户需要的功能、安装、操作与限制，不堆放调试历史或发布待办。
2. 行为变化更新对应使用说明或 API 文档；自动化测试结果以实际 CI 运行记录为准。
3. 不把浏览器 fixture 或模拟测试写成真实 Desktop 验收。
4. 发布新版本前核对 README 命令、相对链接、源代码行为和许可。

价格草稿的来源失效和数值显示规则集中在 src/client/price-draft.ts。开发依赖锁定 ESLint、typescript-eslint、React Hooks 规则和 Prettier；这些工具不随插件运行。CI 另在 Ubuntu 执行 verify，浏览器布局验收仍在 Windows Edge 上执行。

## 后续版本待办

以下是尚未实现的候选改进，不代表当前版本已支持，也不绑定具体版本或交付时间。实施时先明确行为与验收范围，再补对应测试。

| 优先级 | 项目 | 实施与验收要点 |
| --- | --- | --- |
| 中 | 普通模型字段恢复默认 | 增加明确的“移除本地覆盖／恢复默认”操作，区分“留空保留原值”。先核对 Settings 对模型数组及继承值的语义，保留 revision、脱敏字段保护和 maxTokens 变化确认；恢复后可能仍有宿主或上游输出上限，不能承诺无限输出。 |
| 中 | 单项价格清除 | 提供显式删除或恢复未知操作，保留“留空不修改”和明确零价的现有语义；区分直接单价与倍率参考，覆盖来源信息清理和重启恢复。 |
| 中 | 官方模型家族扩展 | 核对目录真实 provider ID、精确模型候选和地域条目后，再扩展 moonshot、豆包、Llama、阶跃等家族；名称前缀不能单独证明官方来源。覆盖官方权重、推理请求值来源和非官方同名候选，避免误判及模糊匹配。 |
| 中 | 外部配置变化提示 | 保留用户草稿的同时，提示当前模型或价格版本已经变化；区分无关配置与当前目标变化，继续拒绝过期写入，不自动覆盖或丢弃草稿。 |
| 中 | 真实宿主验收 | 在 DSH Desktop 与完整 llm-pi-ai 适配器上验证导入、覆盖、输出上限、保存及重连，记录具体宿主版本；浏览器 fixture 和有限字段 schema 集成测试不能替代此验收。 |
| 低 | 缺协议地址的匹配兼容 | 先验证宿主是否接受无协议 baseURL、是否会自行规范化，再决定统一校验或仅对匹配提示作规范化。不得把无效路由误判为已验证可用，也不无条件补 HTTPS。 |
| 低 | ETag／304 条件请求 | 先验证各目录端点及重定向后的响应头支持情况，再考虑 ETag／Last-Modified；覆盖首次下载、304 无缓存、内容变化、失败恢复和强制刷新语义，保留响应大小限制、并发复用和请求取消。 |
| 低 | 界面国际化 | 提取界面与服务错误文案，跟随宿主语言并提供缺失翻译回退；保留稳定错误码和来源数据。现有 locale 文件主要是插件元信息，不代表界面已经支持切换语言。 |
| 低 | 客户端与发布包精简 | 评估 Zod Mini 或更细的导入方式，保持请求／响应校验、错误提示、类型与宿主模块工厂一致；分别测量压缩前后体积，不预设 100 KB 目标。评估移除包内非运行入口 JS 和 README 远程引用的截图，同时保留所需声明、宿主模块及第三方许可。 |
| 低 | 编辑器状态与测试维护 | 按实际复杂度拆分价格草稿、保存请求和 Panel 状态逻辑，保留跨命名空间部分失败与并发保护；为关键规则增加独立测试，继续保留浏览器集成覆盖。 |
| 低 | 文档与诊断一致性 | 补齐中英文 README 功能与致谢对应，发布前核对固定截图是否仍准确；细化供应商不存在／类型不支持的提示及中英文错误文案。用户界面保持简洁，完整校验诊断可另供排障使用。 |
