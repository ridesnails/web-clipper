---
name: api-testing
description: API 测试技能，针对 web-clipper 端点设计测试用例和 Mock 策略
allowed-tools: filesystem-read, filesystem-replaceedit, terminal-execute
---

# API 测试技能

## 测试范围

### 1. 端点测试（POST /）
- **鉴权测试**：缺少 Authorization、错误 Bearer token → 期望 401
- **参数测试**：缺少 url 字段、非字符串 url、无效 URL → 期望 400
- **方法测试**：GET/PUT/DELETE → 期望 405

### 2. Mock 外部依赖
- **Mock Jina Reader**：模拟成功响应和失败响应
- **Mock FNS API**：模拟笔记写入成功和失败

### 3. 工具函数测试
- `isValidUrl`：合法 http/https URL、非法协议、空字符串
- `extractTitle`：从 jina 响应提取 Title、H1、无标题回退
- `makeSlug`：特殊字符过滤、空格转横线、长度限制
- `cleanJinaBody`：正确剥离元信息头、保留正文

### 4. 集成测试
- 使用 `SELF.fetch` 进行端到端测试
- 验证完整流水线：请求 → Jina → FNS → 响应

## 运行测试
```bash
npx vitest        # 交互模式
npx vitest run    # CI 模式
```
