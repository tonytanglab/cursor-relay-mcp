# AI-CDL Spec

## Tier 判定

- Tier 1：文档或不改变运行时行为的小改动。
- Tier 2：局部实现改动，影响范围明确且不涉及权限、持久化或外部协议。
- Tier 3：新组件、外部 SDK/MCP 协议、权限边界、持久化、并发、恢复、发布或安全相关改动。

本项目初始实现为 Tier 3。

## PRE-FLIGHT

Tier 3 修改前必须：

1. 记录目标、非目标、外部依赖版本和主要风险。
2. 确认不读取、记录或持久化 `CURSOR_API_KEY`。
3. 为 SDK 边界、状态迁移、幂等性、权限和超时设计可替换接口与测试。
4. 确认所有写入目标位于项目或明确配置的状态目录。

## 必须验证

Tier 3 交付前必须运行：

```powershell
npm run format:check
npm run lint
npm run typecheck
npm test
npm run build
npm run test:mcp
npm run check:package
```

涉及 `@cursor/sdk` 版本变化时还必须运行 `npm run test:sdk-contract`。真实 Cursor API 冒烟测试只在显式提供凭据并授权计费时执行；默认测试不得访问真实账户。

## 变更日志

按根目录 `AGENTS.md` 更新 `CHANGELOG.md`。失败的验证必须在交付说明中明确列出，不得以忽略错误或降低断言通过。
