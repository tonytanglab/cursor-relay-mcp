# 项目规范

- 全链路使用 UTF-8 无 BOM；PowerShell、Node.js 和 Python 的文件读写必须显式指定 UTF-8。
- 修改代码前必须阅读本文件和项目根目录 `AI-CDL Spec.md`，按其中 Tier 执行 PRE-FLIGHT、验证和测试。
- 代码修改必须同步更新项目根目录 `CHANGELOG.md`。写入前运行 `Get-Date -Format 'yyyy-MM-dd HH:mm'`，记录使用简体中文并倒序追加到最近版本标题下。
- 不提交密钥、`.env`、本地状态、SDK 检查点、构建产物、依赖目录或 npm 缓存。
- Cursor SDK 是外部 public beta 边界：业务代码只依赖 `CursorSdkPort`，版本升级必须通过契约测试。
- 默认安全失败：工作区必须位于显式白名单，危险权限必须二次确认，状态损坏不得静默忽略。
