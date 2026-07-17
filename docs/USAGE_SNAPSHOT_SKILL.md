# 项目上下文：Snapshot 与 Project Skill

此页保留原有 README 链接。完整的中文操作说明已并入 [MoCode 使用指南](./usage.md#项目上下文)。

- **Project Snapshot**：默认开启；自动扫描项目并生成 `.mocode/snapshot.json`，可用 `/snapshot` 管理、`/snapshot_refresh` 重建。
- **Project Skill**：默认关闭；用 `/project_skill on` 或 `MOCODE_PROJECT_SKILL=true` 开启，随后可用 `/project_skill init` 生成 `.mocode/project-skill.md`。
- **`MOCODE.md`**：用 `/init` 让 Agent 为项目生成每轮自动加载的项目记忆。
