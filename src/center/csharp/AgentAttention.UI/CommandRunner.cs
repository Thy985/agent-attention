using System;
using System.Diagnostics;
using System.Threading.Tasks;

namespace AgentAttention.UI;

/// <summary>
/// M6b: Command runner that tries IPC RPC first, falls back to CLI spawn.
/// </summary>
public sealed class CommandRunner
{
    private readonly IpcClient? _ipc;
    private readonly Action _markAllReadCli;
    private readonly Action<string> _markReadCli;
    private readonly Action<string> _jumpCli;

    public CommandRunner(IpcClient? ipc, Action markAllReadCli, Action<string> markReadCli, Action<string> jumpCli)
    {
        _ipc=ipc;
        _markAllReadCli=markAllReadCli;
        _markReadCli=markReadCli;
        _jumpCli=jumpCli;
    }

    public void MarkAllRead()
    {
        if(_ipc!=null&&_ipc.IsConnected)
        {
            _=Task.Run(async()=>{
                try
                {
                    var result=await _ipc.SendCommand("mark-all-read");
                    if(result!=null&&result.Ok==true)return;
                }
                catch{}
                // Fallback to CLI
                _markAllReadCli();
            });
            return;
        }
        _markAllReadCli();
    }

    public void MarkRead(string eventId)
    {
        if(_ipc!=null&&_ipc.IsConnected)
        {
            _=Task.Run(async()=>{
                try
                {
                    var result=await _ipc.SendCommand("mark-event",eventId);
                    if(result!=null&&result.Ok==true)return;
                }
                catch{}
                _markReadCli(eventId);
            });
            return;
        }
        _markReadCli(eventId);
    }

    public void Jump(string agentId)
    {
        if(_ipc!=null&&_ipc.IsConnected)
        {
            _=Task.Run(async()=>{
                try
                {
                    var result=await _ipc.SendCommand("jump",agentId);
                    if(result!=null&&result.Ok==true)return;
                }
                catch{}
                _jumpCli(agentId);
            });
            return;
        }
        _jumpCli(agentId);
    }
}

/// <summary>
/// Legacy CLI-only command runner (used when no IPC is available).
/// </summary>
public sealed class CliCommandRunner
{
    private readonly string _cliPath;

    public CliCommandRunner(string cliPath)
    {
        _cliPath=cliPath;
    }

    public void MarkAllRead()=>StartCli("mark-all-read");
    public void MarkRead(string eventId)=>StartCli("mark-event",eventId);
    public void Jump(string agentId)=>StartCli("jump",agentId);

    private void StartCli(string command,string? argument=null)
    {
        if(string.IsNullOrWhiteSpace(_cliPath))return;
        var nodePath=Environment.GetEnvironmentVariable("AGENT_ATTENTION_NODE");
        if(string.IsNullOrWhiteSpace(nodePath))nodePath="node";
        var startInfo=new ProcessStartInfo
        {
            FileName=nodePath,
            UseShellExecute=false,
            CreateNoWindow=true,
            WindowStyle=ProcessWindowStyle.Hidden,
        };
        startInfo.ArgumentList.Add(_cliPath);
        startInfo.ArgumentList.Add(command);
        if(!string.IsNullOrWhiteSpace(argument))
            startInfo.ArgumentList.Add(argument);
        _=Task.Run(()=>{
            try
            {
                using var process=Process.Start(startInfo);
                process?.WaitForExit(10_000);
            }
            catch{}
        });
    }
}
