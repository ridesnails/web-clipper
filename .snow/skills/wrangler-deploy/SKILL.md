---
name: wrangler-deploy
description: Wrangler/Cloudflare Workers 部署工作流技能，支持 dev、deploy、secrets、tail 等操作
allowed-tools: terminal-execute, filesystem-read, filesystem-replaceedit
---

# Wrangler 部署技能

## 适用场景
- 本地开发：`npx wrangler dev`
- 部署到 Cloudflare：`npx wrangler deploy`
- 查看日志：`npx wrangler tail`
- 管理 Secrets：`npx wrangler secret put <KEY>`

## 部署前检查清单
1. 运行 `npx vitest run` 确保所有测试通过
2. 确认代码已通过 Prettier 格式化
3. 确认所需 Secrets（API_KEY, FNS_TOKEN）已配置
4. 检查 `wrangler.jsonc` 配置正确

## 常用命令
```bash
npx wrangler dev          # 本地开发
npx wrangler deploy       # 部署
npx wrangler tail         # 查看实时日志
npx wrangler secret put API_KEY   # 设置密钥
npx wrangler secret put FNS_TOKEN # 设置 FNS 密钥
```
