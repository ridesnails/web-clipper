---
name: docs-writing
description: 文档编写标准技能，规范 README、API 文档、用户指南和 CHANGELOG 的编写
allowed-tools: filesystem-read, filesystem-replaceedit
---

# 文档编写技能

## 语言规范
- **所有面向用户的文档必须使用中文**
- 技术术语可保留英文（如 API、Worker、frontmatter）
- 代码注释建议使用中文

## README.md 规范
应包含以下章节：
1. **项目简介** — 一句话说明项目用途
2. **特性** — 用列表展示核心卖点
3. **工作原理** — 流程图或步骤说明
4. **API 文档** — 请求/响应格式、状态码、错误处理
5. **客户端接入示例** — iOS Shortcut、Bookmarklet、curl
6. **部署指南** — 或链接到 DEPLOYMENT.md

## API 文档规范
- 说明请求方法、Headers、Body 格式
- 提供成功/失败的响应示例
- 列出所有状态码及含义
- 示例：
```markdown
### `POST /`

**Headers**
| Name | Required | Description |
|---|---|---|
| `Authorization` | ✅ | `Bearer <API_KEY>` |
```

## CHANGELOG 规范
- 按版本分组
- 每个版本包含：新增、修复、变更
- 示例：
```markdown
## v0.2.0
- feat: 添加 URL 校验
- fix: 修复 FNS 写入失败时未返回正确状态码
```

## 内部技术文档
- 架构说明可使用中文或中英混合
- AGENTS.md 应保持更新，反映最新技术栈
