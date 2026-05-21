---
name: git-workflow
description: Git 工作流规范技能，涵盖分支管理、提交信息、PR 流程和版本发布
allowed-tools: terminal-execute, filesystem-read
---

# Git 工作流技能

## 分支规范
- 主分支：`main`
- 功能分支：`feature/<描述>`，如 `feature/add-retry-logic`
- 修复分支：`fix/<描述>`，如 `fix/jina-timeout`
- 文档分支：`docs/<描述>`，如 `docs/update-readme`

## 提交信息规范
- 使用中文或英文，但需保持一致性
- 推荐格式：`<type>: <描述>`
  - `feat:` 新功能
  - `fix:` 修复
  - `docs:` 文档
  - `test:` 测试
  - `refactor:` 重构
  - `chore:` 杂项
- 示例：`feat: 添加 Jina Reader 失败重试机制`

## PR 流程
1. 从 main 创建功能分支
2. 开发完成后确保测试通过
3. 提交 PR，描述清楚改动原因和影响范围
4. 自我审查代码风格（Prettier/EditorConfig）
5. 合并到 main

## 版本标签
- 使用语义化版本：v0.1.0, v0.2.0
- 重大变更时更新版本号
