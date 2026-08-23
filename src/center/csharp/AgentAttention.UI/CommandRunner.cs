using System.Diagnostics;

namespace AgentAttention.UI;

public sealed class CommandRunner
{
    private readonly string _cliPath;

    public CommandRunner(string cliPath)
    {
        _cliPath=cliPath;
    }

    public void MarkAllRead() => StartCli("mark-all-read");
    public void MarkRead(string eventId)=>StartCli("mark-event",eventId);
    public void Jump(string agentId)=>StartCli("jump",agentId);

    private void StartCli(string command,string? argument=null)
    {
        if(string.IsNullOrWhiteSpace(_cliPath))
        {
            return;
        }

        var nodePath=Environment.GetEnvironmentVariable("AGENT_ATTENTION_NODE");
        if(string.IsNullOrWhiteSpace(nodePath))
        {
            nodePath="node";
        }

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
        {
            startInfo.ArgumentList.Add(argument);
        }

        _=Task.Run(()=>
        {
            try
            {
                using var process=Process.Start(startInfo);
                process?.WaitForExit(10_000);
            }
            catch(Exception)
            {
            }
        });
    }
}
