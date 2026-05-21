# ROLE.md - 项目角色与规范定义

> 本文档定义了在 web-clipper 项目中参与开发和维护时的角色规范、代码风格、测试要求及部署流程。

---

## 1. 语言偏好

- **项目主要语言：中文**
- 所有面向用户的文档（README、API 文档、用户指南）必须使用中文撰写
- 代码注释建议使用中文，技术术语可保留英文
- 提交信息（Commit Message）可使用中文或英文，但需保持一致性

---

## 2. 代码风格规则

### 2.1 语言与环境
- **JavaScript（ES Modules）**，不使用 TypeScript
- 单文件 Worker 架构，核心逻辑位于 `src/index.js`
- 零生产依赖（zero-dependency worker）

### 2.2 Prettier 配置
```json
{
  "useTabs": true,
  "singleQuote": true,
  "semi": true,
  "printWidth": 140
}
```

### 2.3 EditorConfig 配置
```ini
root = true

[*]
indent_style = tab
end_of_line = lf
charset = utf-8
trim_trailing_whitespace = true
insert_final_newline = true
```

### 2.4 文件命名规范
- 使用 `snake_case` 或 `kebab-case`
- 示例：`index.js`、`index.spec.js`、`wrangler.jsonc`、`vitest.config.js`

---

## 3. 测试要求

### 3.1 测试框架
- **Vitest** 作为测试运行器
- 使用 `@cloudflare/vitest-pool-workers` 进行 Cloudflare Workers 环境模拟

### 3.2 测试文件位置
- 测试文件与源文件同目录或相邻，命名格式为 `*.spec.js` 或 `*.test.js`

### 3.3 覆盖率期望
- 核心 fetch handler 逻辑应达到高覆盖率
- 关键边界条件（如 API 失败、参数缺失）必须覆盖

### 3.4 运行测试
```bash
npx vitest
```

---

## 4. 文档标准

- **用户面向文档必须使用中文**
- `README.md` 应包含：项目简介、安装步骤、配置说明、部署指南
- API 文档需说明请求/响应格式、状态码及错误处理
- 内部技术文档（如架构说明）可使用中文或中英混合

---

## 5. 架构模式

### 5.1 Cloudflare Workers Fetch Handler
- 项目采用标准的 Cloudflare Workers `fetch` 事件处理模式
- 入口文件 `src/index.js` 导出 `default` 对象，包含 `fetch` 方法

```javascript
export default {
  async fetch(request, env, ctx) {
    // 请求处理逻辑
  },
};
```

### 5.2 外部集成
- **Jina Reader API**：用于网页内容提取与阅读模式转换
- **Fast Note Sync Service (FNS)**：用于笔记同步

### 5.3 运行时标志
- `nodejs_compat` 标志已启用，确保 Node.js API 兼容性

---

## 6. 安全注意事项

### 6.1 密钥管理
- **API_KEY 必须通过 Cloudflare Secrets 或环境变量注入**
- 严禁在代码中硬编码任何凭证、令牌或密钥
- 使用 `env.API_KEY` 方式在 Worker 中读取密钥

### 6.2 请求验证
- 对传入请求进行来源和参数校验
- 避免将用户输入直接拼接到外部 API 请求中

### 6.3 敏感信息
- 禁止在日志、错误响应或调试输出中暴露密钥信息

---

## 7. 部署说明

### 7.1 部署工具
- 使用 **Wrangler CLI** 进行部署

### 7.2 部署命令
```bash
npx wrangler deploy
```

### 7.3 部署前检查清单
- [ ] 所有测试通过 (`npx vitest run`)
- [ ] 代码已通过 Prettier 格式化
- [ ] 所需 Secrets 已在 Cloudflare Dashboard 或 Wrangler 中配置
- [ ] `wrangler.jsonc` 配置正确

### 7.4 配置文件
- `wrangler.jsonc`：Wrangler 部署配置
- `vitest.config.js`：测试配置

---

## 8. 开发依赖

| 包名 | 用途 |
|------|------|
| `wrangler` | Cloudflare Workers 开发、预览与部署 |
| `vitest` | 单元测试框架 |
| `@cloudflare/vitest-pool-workers` | Workers 运行时测试环境 |

---

> 维护者请注意：更新本文件时，请确保所有规范仍与项目实际配置保持一致。
