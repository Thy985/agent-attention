using System;
using System.IO;
using System.IO.Pipes;
using System.Linq;
using System.Threading.Tasks;
using System.Text;
using System.Net.Sockets;

namespace AgentAttention.UI;

/// <summary>
/// IPC client that connects to the daemon state-push server over TCP.
/// Falls back to file polling when the server is unavailable.
/// </summary>
public sealed class IpcClient : IDisposable
{
    private readonly string _stateDir;
    private readonly StateStore _store;
    private bool _running;
    private Task? _connectTask;
    private int _port;

    public event Action<AttentionState>? OnStateUpdate;

    public bool IsConnected => _port > 0;

    public static bool CanConnect(string stateDir)
    {
        try
        {
            var portFile=Path.Combine(stateDir,"ipc-port.txt");
            if(!File.Exists(portFile))return false;
            return int.TryParse(File.ReadAllText(portFile).Trim(),out var p) && p>0;
        }
        catch{return false;}
    }

    public IpcClient(string stateDir, StateStore store)
    {
        _stateDir=stateDir;
        _store=store;
        _port=ReadPort(stateDir);
    }

    public void Start()
    {
        if(_running || _port<=0)return;
        _running=true;
        _connectTask=Task.Run(ConnectLoop);
    }

    public void Stop()
    {
        _running=false;
        _connectTask=null;
    }

    public void Dispose()=>Stop();

    private async Task ConnectLoop()
    {
        while(_running)
        {
            try
            {
                using var client=new TcpClient();
                await client.ConnectAsync("127.0.0.1",_port);
                using var stream=client.GetStream();
                using var writer=new StreamWriter(stream,new UTF8Encoding(false)){AutoFlush=true};
                using var reader=new StreamReader(stream,new UTF8Encoding(false));
                await writer.WriteLineAsync("{\"type\":\"subscribe\"}");
                while(_running && client.Connected)
                {
                    var line=await reader.ReadLineAsync();
                    if(line==null)break;
                    try
                    {
                        var msg=System.Text.Json.JsonSerializer.Deserialize<PipeMessage>(line,Json.Options);
                        if(msg?.Type=="state" && msg.State!=null)
                            OnStateUpdate?.Invoke(msg.State);
                    }
                    catch{}
                }
                await Task.Delay(500);
                var p=ReadPort(_stateDir);
                if(p!=_port){_port=p;}
            }
            catch(Exception)
            {
                if(!_running)break;
                await Task.Delay(1000);
            }
        }
    }

    private static int ReadPort(string stateDir)
    {
        try
        {
            var portFile=Path.Combine(stateDir,"ipc-port.txt");
            if(File.Exists(portFile))
            {
                var v=int.TryParse(File.ReadAllText(portFile).Trim(),out var n)?n:0;
                return v;
            }
        }
        catch{}
        return 0;
    }
}

internal sealed class PipeMessage
{
    [System.Text.Json.Serialization.JsonPropertyName("type")]
    public string? Type { get; set; }
    [System.Text.Json.Serialization.JsonPropertyName("state")]
    public AttentionState? State { get; set; }
}
