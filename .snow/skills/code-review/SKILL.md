---
name: code-review
description: 代码审查技能，检查代码风格合规性、逻辑正确性、测试覆盖率和安全性
allowed-tools: filesystem-read, filesystem-replaceedit, ace-search
---

# 代码审查技能

## 审查维度

### 1. 代码风格
- 检查是否遵循 Prettier 配置（tabs, singleQuote, semi, printWidth 140）
- 检查 EditorConfig 合规性（LF 换行、UTF-8、末尾换行）
- 文件命名是否使用 snake_case 或 kebab-case

### 2. 逻辑正确性
- Worker fetch handler 是否正确处理 HTTP 方法
- 错误处理是否完善（try/catch、状态码返回）
- 异步操作是否有超时控制（如 AbortSignal.timeout）

### 3. 测试覆盖
- 核心 fetch handler 是否有单元测试
- 边界条件是否覆盖（缺少 URL、鉴权失败、API 超时）
- 工具函数（extractTitle, makeSlug, cleanJinaBody）是否有独立测试

### 4. 安全审查
- 是否硬编码了 API_KEY 或 FNS_TOKEN
- 用户输入（URL）是否经过校验（isValidUrl）
- 错误响应中是否泄露了敏感信息
