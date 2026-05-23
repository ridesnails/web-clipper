# Changelog

本项目的用户可见变更记录放在这里。

格式参考 Keep a Changelog，版本语义当前以时间点为主，后续如引入正式版本号可继续沿用。

## [0.1.0] - 2026-05-23

### Added

- 新增 `CHANGELOG.md`，开始集中记录项目变更。

### Changed

- 将测试运行方式从 `@cloudflare/vitest-pool-workers` 切换为稳定的 `Vitest + Node` 直调 Worker handler。
- `test/index.spec.js` 不再依赖 `cloudflare:test` 和 `SELF.fetch`，改为通过出站 HTTP mock 覆盖主链路行为。
- Jina 重试失败用例改为使用假定时器，避免测试中真实等待重试延迟。
- `README.md` 已同步当前实现，修正文档中“单文件 Worker”、CORS 方法和输出示例等旧口径。
- `DEPLOYMENT.md` 已同步当前实现，补充 `PUBLIC_BASE_URL` 的使用时机、从零初始化时所需文件范围，以及真实的本地验证返回示例。

### Removed

- 移除未再使用的开发依赖 `@cloudflare/vitest-pool-workers`。

### Fixed

- 修复当前环境下 `wrangler/workerd` 测试池卡住导致 `npm test -- --run` 无法稳定完成的问题。
- 恢复全量测试可执行状态，当前测试结果为 `81/81` 通过。
