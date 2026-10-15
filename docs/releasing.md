# GitHub Release 发布指南

本项目使用手动触发的 `.github/workflows/release.yml`，从仓库内的双语条目生成 Release 说明，构建安装包并上传附件。普通 push／PR 仍只运行原有 CI；不自动升级版本，也不执行 npm publish。

## 开发时记录变化

后续完成功能或修复时，在同一次改动中向 `.changes/entries/` 添加简短的中英变更条目，具体格式见 [条目说明](../.changes/README.md)。已发布文件保留不动；尚未发布的同一功能条目可继续完善。

工作流从 GitHub 已发布的版本中选择最高版本作为基线，要求它的标签是本次提交的祖先；只汇总基线之后新增的条目，按文件名排序，生成与 v0.1.3／v0.1.4 一致的中文、英文和兼容说明结构。修改／删除旧条目、缺少任一语言或没有新条目都会阻止发布；计划与已实现功能必须区分。

## 一条命令发布

先完成待发布代码、双语条目及版本号，并提交 push 到 main。版本由维护者确定，例如：

```sh
npm version 0.1.5 --no-git-tag-version
```

此命令只同步本地 package.json 与 package-lock.json，不提交、不打标签；将版本改动与本次发布内容一起提交并推送。然后在已登录且具有仓库操作权限的 GitHub CLI 中执行：

```sh
gh workflow run release.yml --ref main
```

也可以在仓库 Actions → Release → Run workflow 选择 main。工作流文件须先推送到默认分支才可使用；发布仅支持 main，始终固定到触发时的提交，不在后续步骤悄悄改为更新后的分支头。

工作流执行：

1. 检查 package.json 与锁文件的包名／版本一致，拒绝已有标签、Release 或同版本草稿，并生成双语日志。
2. Ubuntu 执行 npm ci 和 npm run verify；Windows 执行同样检查及六组 Edge 浏览器测试。
3. 从已验证的 Ubuntu 构建产物执行 npm pack --ignore-scripts，不重复构建；核对包内版本和必要运行入口，生成 SHA256SUMS。
4. 所有测试通过后，publish job 下载同一次运行的产物，重新校验提交、版本、日志、发布基线和包校验和，创建对应标签与 Release，附加 `.tgz` 和 SHA256SUMS。

正式版本标为 Latest；如版本带 `-beta.1` 等 SemVer 预发布后缀，则发布为 prerelease，不设为 Latest。当前工作流面向 main 的单一递增发布序列，版本必须高于已有所有正式／预发布版本；不支持并行维护旧版本线或带 `+build` 的版本号。

已有 v0.1.4 不会因配置此流程再次发布。下次正式发布前应确定新版本并同步两个 manifest；纯文档提交无需因此发版。

## 试运行与本地预览

完整试运行：

```sh
gh workflow run release.yml --ref main -f dry_run=true
```

试运行执行构建、测试和产物检查，提供 14 天有效的 `release-bundle` Actions artifact，包括安装包、SHA256SUMS、notes.md 和 manifest.json，并在运行摘要展示日志；跳过 publish job，不创建标签或 Release。可使用当前已发布版本号进行试运行，日志仍只包含该基线之后的变化；这不表示生成包是 npm 上已发布包的相同产物。

本地只预览双语日志，将基线替换为上一次实际发布标签：

```sh
npm run release:notes -- --from v0.1.4
```

输出为 work/release/notes.md，不联网、不创建标签或发布。脚本测试是 `node --test test/release.test.mjs`，也随 npm test／verify 执行。

## 权限、重试与 npm

- 使用 Actions 自带的 GITHUB_TOKEN，不需要保存个人 PAT 或 npm token。构建和测试只有 contents:read，最后的 publish job 才有 contents:write；仓库／组织策略仍须允许 Actions 使用该写权限。
- 官方 Actions 固定完整提交 SHA；更新时核对官方版本与 runner 要求。包与日志不拼进 shell 命令，不执行变更条目中的内容。
- 发布全局串行且不取消运行中的发布。重复执行不会覆盖已有版本或附件；若已有更高版本、已发布基线不在当前历史中或构建期间基线变化，先检查历史与版本再重试。
- 若失败发生在创建标签之后，可能留下标签或草稿。先检查 Actions 日志、目标提交和已上传附件，由维护者决定补全该次发布或使用新版本；流程不会为重试自动删除、覆盖或移动标签，也不会自动清理草稿。
- npm 继续由维护者手动发布。GitHub Release 成功不表示 npm 已更新，npm 版本徽章仍显示 npm 上的版本。可下载并核对 Release 附件后手动发布同一 `.tgz`，避免另一次构建引入差异。
- 自动生成的是仓库已记录条目的汇总与排版，不使用模型 API 翻译，也不声称自动理解全部代码差异；双语内容质量在开发与审查阶段保证。

流程实现参考：[手动触发工作流](https://cli.github.com/manual/gh_workflow_run)、[创建 Release 与上传附件](https://cli.github.com/manual/gh_release_create)。
