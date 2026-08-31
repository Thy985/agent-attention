# Agent Attention — 下一步规划

> 基于当前架构（v0.3 Integration Capability Catalog）和 Bug 调查（BUG_FINDINGS.md）

---

## 一、已完成（v0.3）

| 模块 | 状态 | 提交 |
|------|------|------|
| Integration Capability Catalog | ✅ 完成 | da597ac |
| 5 层接入等级 (L0-L7) | ✅ 定义 | da597ac |
| Mechanism Providers (Hook/Wrapper/Skill/Plugin) | ✅ 实现 | da597ac |
| Claude Code Hook 集成 | ✅ 验证 | da597ac |
| 6 个 Agent Manifest | ✅ 创建 | da597ac |
| 23 个 Integration 测试 | ✅ 通过 | da597ac |
| 198 总测试 | ✅ 全部通过 | - |
| AGENT_CAPABILITY_MATRIX.md | ✅ 完成 | da597ac |

---

## 二、下一步优先级

### P0: 修复剩余关键 Bug（BUG_FINDINGS.md 第六节）

| # | 修复内容 | 工作量 | 优先级 |
|---|---------|--------|--------|
| 1 | **P1-12** `Start-Sleep` 阻塞 UI 线程 → 改用 WPF `DispatcherTimer` | 大（重构） | P0 |
| 2 | **P2-4** `tray-state.json` 半写竞态 → 原子写 | 中 | P1 |
| 3 | **P2-5** `Update-NotifyIcon` 跳过 → 比较键补全 | 小 | P1 |
| 4 | **P2-6/P2-7** GDI/USER 泄漏 → Dispose + DestroyIcon | 中 | P1 |
| 5 | **P2-8** Center 每 2s 整树重建 → 增量更新 | 大（重构） | P2 |
| 6 | **P2-11** 路径空格截断 → 正确引号处理 | 小 | P1 |
| 7 | **P3-6** `doctor` Sound/Toast 假阳性 → 实查 API | 小 | P2 |
| 8 | **P3-8** registry 并发覆盖 → 原子写 | 中 | P2 |
| 9 | **P3-10/P3-11** `agent_name` 丢失 → 修复 autoDetectAndRegister | 小 | P2 |

**预计**: 3-5 天（含测试）

---

### P1: 核心功能完善

| # | 功能 | 说明 | 工作量 |
|---|------|------|--------|
| 1 | **Cline Hook Adapter** | Cline 有 `cline hook` 子命令，需适配机制提供者 | 0.5 天 |
| 2 | **Codex Wrapper 脚本** | 文档化 wrapper 脚本 + 自动安装 | 0.5 天 |
| 3 | **OpenCode Plugin 调研** | 逆向 OpenCode Plugin API，确认 hooks 格式 | 1-2 天 |
| 4 | **Center Window 增量更新** | 避免每 2s 整树重建（P2-8） | 大（重构） |
| 5 | **Quiet Hours 支持** | 用户可配置静默时段 | 1 天 |
| 6 | **Notification Action Buttons** | Toast 按钮允许 Allow/Deny | 1 天 |

---

### P2: 产品化

| # | 功能 | 说明 | 工作量 |
|---|------|------|--------|
| 1 | **LICENSE 文件** | 目前缺少 | 0.1 天 |
| 2 | **npm publish** | 正式发布到 npm | 0.5 天 |
| 3 | **CI/CD Pipeline** | GitHub Actions 自动测试 + 发布 | 1 天 |
| 4 | **ChangeLog** | 版本变更记录 | 0.5 天 |
| 5 | **macOS/Linux 支持** | 当前 Windows only | 大（跨平台） |
| 6 | **Settings UI** | 用户可通过 GUI 配置 | 2 天 |

---

### P3: 长期愿景

| # | 方向 | 说明 |
|---|------|------|
| 1 | **MCP Server** | 让其他 AI 工具通过 MCP 接入 |
| 2 | **多用户路由** | 家庭/团队场景中按用户路由通知 |
| 3 | **Focus Awareness** | 检测用户是否在使用计算机，智能延迟通知 |
| 4 | **Task Dependency** | 理解任务依赖，聚合相关通知 |
| 5 | **Cloud Sync** | 多设备同步通知历史 |

---

## 三、建议的执行顺序

### 本周（5 天）
```
Day 1: P0-1 (P1-12 Start-Sleep 阻塞) + P0-2 (P2-4 tray-state 竞态)
Day 2: P0-3~5 (P2-5/6/7 GDI 泄漏)
Day 3: P1-1 (Cline Hook) + P1-2 (Codex Wrapper)
Day 4: P1-3 (OpenCode Plugin 调研)
Day 5: 测试 + 文档 + 提交
```

### 下周（DSH 接入 + 产品化）
```
Day 1: 调研 DeepSeek Harness 接入机制 → docs/dsh-integration-research.md
Day 2: 实现 MCP Server (src/mcp-server.ts) + 更新 package.json
Day 3: dsh-mcp-client cordis.yml 接入验证 (headless profile)
Day 4: 创建 SKILL.md (L1 自动发现) + 完整 E2E 验证
Day 5: 更新 NEXT_STEPS + BUG_FINDINGS + commit/push
```

### 下下周
```
- 完成剩余 P0/P1 Bug 修复
- 开始 P2 产品化（LICENSE + npm publish）
- 评估 Center Window 增量更新重构
```

---

## 四、架构决策备忘

1. **不做 per-agent Adapter** — 使用 Mechanism Provider + Manifest 配置
2. **Completion Semantic 与 Hook 解耦** — Hook ≠ Reliable completion，用 `CompletionReliability` 诚实表达
3. **新 Agent 从 L1 开始** — Skill 是最低门槛，可逐步升级到 L3/L4
4. **Core 不关心 Agent 是谁** — 只处理 Canonical Attention Events
5. **DSH 接入等级确认** — 详见 `docs/dsh-integration-research.md`
   - dsh **支持**：L1 SKILL.md（`dsh-skill-filesystem`）、L4 MCP（`dsh-mcp-client`）、L4 动态 Cordis Plugin
   - dsh **不支持**：L2 Wrapper 约定、L3 stdin JSON Hook、Agent Identity 声明
   - **推荐路径**：先实现 MCP Server（L4），再补充 SKILL.md（L1），二者叠加覆盖所有 DSH profile

## 五、DSH 接入优先级（2026-08-31 调研结论）

| 等级 | dsh 支持 | 实现难度 | 优先级 |
|------|---------|---------|--------|
| L4 MCP Server | ✅ `dsh-mcp-client` | 中（需新增 @modelcontextprotocol/sdk） | **P0**（首选） |
| L1 SKILL.md | ✅ `dsh-skill-filesystem` | 低（只需写文档） | P1（补充） |
| L4 动态 Plugin | ✅ `cordis_define/run` | 高（需理解 Cordis API） | P2（可选） |
| L3 Hook | ❌ 不支持 | — | 不适用 |
| L2 Wrapper | ❌ 无约定 | — | 不适用 |


---

## 六、验证标准

每次提交前确保:
- [ ] `npm test` 208/208 通过
- [ ] `npm run build` 干净编译
- [ ] E2E 验证: `agent-attention integration list` + `hook` 命令
- [ ] 无 state.json 腐蚀
- [ ] 无 tmp 泄漏
- [ ] 无 GDI/USER 泄漏（实机检查）
