# 旧宿主回归

主开发环境使用根目录锁文件中的 DSH `0.2.2-rc.1`。本目录的
`legacy-package-lock.json` 固定 DSH `0.2.0-rc.2`、Cordis `4.0.4` 和 Loader `1.0.5`。
插件依赖 Schemastery `~3.18.5 || ~3.19.0`，与宿主共用同一份：主锁解析为 `3.19.0`，旧锁解析为 `3.18.5`，测试检查两套锁都只有一份。其余开发工具、实际发布依赖和 peer 范围与主项目一致。

```sh
npm run test:legacy -- --ui
```

该命令在 `work/host-legacy-*` 创建隔离源码副本，通过 `npm ci` 安装，再执行
`verify` 和六组 Edge fixture 测试。没有 Edge 的环境可省略 `--ui`。
它不安装到真实 DSH profile，不触发模型请求，也不修改主工作区的依赖或构建结果。
临时副本保留供排查，测试生成的 profile 仍由各自 fixture 清理。

修改 dependencies、devDependencies、peerDependencies 或 engines 后，运行：

```sh
npm run test:legacy -- --update-lock
npm run test:legacy -- --ui
```

将更新后的锁文件一并提交。更新命令只解析锁文件，不代表验证通过；普通测试会拒绝
过期的依赖声明。插件版本号变化由运行器仅同步到隔离副本，不需要重新解析旧宿主依赖。
主基线与旧基线都使用 npm 官方 registry；两套测试结果均不代表真实 Desktop 验收。

## 本次验证记录

2026-11-10（Asia/Hong_Kong），Windows、Node 26.13.0、npm 12.2.1（CI 使用 Node 22.19.0，以 CI 记录为准）：

| 宿主 | npm ci / verify | Node 测试 | Edge fixture |
| --- | --- | --- | --- |
| 0.2.2-rc.1 | 通过 | 119 / 119 | 六组全部通过 |
| 0.2.0-rc.2 | 通过，使用隔离锁文件 | 119 / 119 | 六组全部通过 |

覆盖真实 Boot／Loader／Settings／ConfigEditor 的临时 profile 持久化，以及两版
llm-pi-ai 的完整 Config schema；目录服务和浏览器远程响应仍为 fixture。
0.2.1-rc.5 本轮不再单独锁定测试，仍在安装范围内。本次未运行完整适配器服务、
真实 Gateway 授权链、真实模型请求或 Desktop shell，未使用用户真实配置。
GitHub CI／Release 尚未触发，本地通过不能写成远程 CI 已通过。
