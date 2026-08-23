# TECH-DEBT — Agent Attention

> 原则：技术债必须显式登记、标明影响与解除条件，不允许以"隐藏问题"的形式存在。
> 登记即接受；未登记的已知问题视为流程违规。

---

## TD-UI-001 — Tray/Center 使用 `Start-Sleep` + `DoEvents` 轮询，阻塞单线程 UI

- **来源**：BUG_FINDINGS.md P1-12（2026-08-21 调查）
- **位置**：
  - `src/center/TrayIcon.ps1`（轮询循环 500ms `Start-Sleep` + `DoEvents()`）
  - `src/center/CenterWindow.ps1`（刷新循环 2000ms `Start-Sleep` + `DoEvents()`）
- **现状**：WPF/WinForms 消息泵与窗口同线程。每个轮询周期内 `Start-Sleep` 整段不泵消息，
  窗口拖动、菜单响应存在可感知的最大 ~500ms（Tray）/ ~2s（Center）迟滞窗口。
- **为什么暂不修**：
  - P0 闭包修复后核心用户场景实测无"卡死"级症状，只有轻微迟滞；
  - 修复需将两个脚本改为事件驱动架构（WPF `DispatcherTimer` /
    WinForms `Timer` 组件或消息驱动 update），属重构而非缺陷修补；
  - 在 v0.3 收口阶段引入 UI 架构重写会重新打开已关闭的 P0 风险面。
- **影响**：UX 迟滞（非功能性失败）；无数据/状态风险。
- **解除条件**（满足其一即应排期）：
  1. 用户实测报告菜单/窗口迟滞不可接受；
  2. Center 引入高频更新需求（如 <1s 刷新）；
  3. 下一次涉及 Center/Tray UI 的结构性改动窗口期顺带完成。
- **目标方案**：
  - Tray：WinForms `System.Windows.Forms.Timer` 组件驱动 tick（消息泵内置），
    移除手写 `while + Start-Sleep + DoEvents`；
  - Center：WPF `DispatcherTimer` 驱动刷新；
  - 两者的退出信号改由 timer stop + window Closed 事件承接。
- **状态**：ACCEPTED（2026-08-22）
- **Not release-blocking for v0.3.**
