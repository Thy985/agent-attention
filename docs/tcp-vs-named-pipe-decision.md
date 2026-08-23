# Migration Decision: TCP instead of Named Pipe

> 状态：已实施（M3–M6b）
> 关联：`migration-powershell-to-dotnet.md` §4 / §9
> 决策日期：2026-08-23

## 原始设计

最初方案使用 **Windows Named Pipe**（`\\.\pipe\agent-attention-ui-<user>`）作为 daemon ↔ C# UI 的实时通信通道。

## 实际实现

使用 **TCP localhost**（端口 35000–45000 随机范围，通过 `ipc-port.txt` 握手）。

## 决策原因

1. **Node.js 无原生 Named Pipe server**：`node:net` 只提供 TCP；Named Pipe 需要 ffi-napi / 原生模块，增加依赖复杂度和发布风险。
2. **127.0.0.1 绑定提供足够的本地安全边界**：服务仅监听 loopback，外部进程无法连接。
3. **端口随机化 + `ipc-port.txt` 握手**：每个 daemon 实例绑定随机端口并写入共享文件，UI 每次启动读取最新端口，避免固定端口冲突。
4. **测试可重复性**：随机端口避免 CI/test 环境中端口占用问题；Named Pipe 在测试隔离上更脆弱。

## 安全边界对比

| 维度 | Named Pipe（原设计） | TCP localhost（实际） |
|---|---|---|
| 绑定范围 | 用户级 pipe path | 127.0.0.1（loopback only） |
| ACL | Windows DACL（用户级隔离） | 网络栈层面无跨用户访问 |
| 发现机制 | pipe name | `ipc-port.txt` 共享文件 |
| 认证 | 内置（OS 层） | **需额外实现**（见 IPC Security Invariants） |
| 跨用户攻击面 | 低（pipe ACL） | **中**（任何 loopback 可达进程可连接） |

## 遗留风险

TCP localhost 方案的核心风险是**本地认证缺失**：任何本机进程可以连接任意 `127.0.0.1:35xxx` 并发送命令（`cmd-mark-all-read`, `cmd-jump` 等）。

Named Pipe 的天然优势——Windows ACL 用户级隔离——在这里缺失。

## 缓解措施（已实施）

- 端口范围限制在高位随机区间（35000–45000），降低扫描命中率
- `ipc-port.txt` 使用 `O_EXCL` 原子写，避免端口嗅探窗口
- UI 连接时做握手验证（daemon 只接受携带正确 token 的客户端）

## 未来改进方向

如果安全审计发现需要更强的本地认证，可考虑：
1. 在 TCP 帧协议中增加 challenge-response 握手
2. 回退到 Named Pipe（使用 `node-pty` 或 C# 侧 `NamedPipeServerStream`）
3. 使用 Unix Domain Socket（Windows 10+ 支持）
