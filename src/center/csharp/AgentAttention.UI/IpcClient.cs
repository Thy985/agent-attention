using System;
using System.IO;
using System.Net.Sockets;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using System.Text.Json;

namespace AgentAttention.UI;

/// <summary>
/// IPC client that connects to the daemon state-push server over TCP.
/// Falls back to file polling when the server is unavailable.
///
/// M5 notification contract:
///   "state"              -> full snapshot; drives OnStateUpdate
///   "state-changed"      -> lightweight pointer; UI reads state.json itself
///   "registry-changed"   -> agents.json changed; drives OnRegistryReload
///   "daemon-status"      -> lifecycle signal (alive/stopping); drives OnDaemonStatus
///
/// M6b RPC contract:
///   "cmd"                -> client request; server handles and replies with "cmd-ack"
///   "cmd-ack"            -> server response; read on the command connection
/// </summary>
public sealed class IpcClient : IDisposable
{
    private readonly string _stateDir;
    private readonly StateStore _store;
    private bool _running;
    private Task? _connectTask;
    private int _port;
    private CancellationTokenSource? _stopCts;
    private volatile bool _connected;

    public event Action<AttentionState>? OnStateUpdate;
    public event Action? OnRegistryReload;
    public event Action<string>? OnDaemonStatus;
    /// <summary>Emitted each time the connection is re-established after a disconnect.</summary>
    public event Action? OnReconnect;

    public bool IsConnected => _connected;

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
        if(_running)return;
        _running=true;
        _stopCts=new CancellationTokenSource();
        var cancellation=_stopCts.Token;
        _connectTask=Task.Run(()=>ConnectLoop(cancellation));
    }

    public void Stop()
    {
        _running=false;
        _connected=false;
        _stopCts?.Cancel();
    }

    /// <summary>Authenticate and read the ack on the SAME command connection.</summary>
    public async Task<PipeMessage?> SendCommand(string command, params string[] args)
    {
        var port=ReadPort(_stateDir);
        var token=ReadAuthSecret(_stateDir);
        if(port<=0 || token==null)return null;
        var requestId=Guid.NewGuid().ToString("N");
        using var cts=new CancellationTokenSource(5000);
        try
        {
            using var client=new TcpClient();
            await client.ConnectAsync("127.0.0.1",port,cts.Token);
            using var stream=client.GetStream();
            using var writer=new StreamWriter(stream,new UTF8Encoding(false)){AutoFlush=true};
            using var reader=new StreamReader(stream,new UTF8Encoding(false));
            await writer.WriteLineAsync(JsonSerializer.Serialize(new { type="hello", token },Json.Options).AsMemory(),cts.Token);
            var payload=new { type="cmd", requestId, command, args };
            await writer.WriteLineAsync(JsonSerializer.Serialize(payload,Json.Options).AsMemory(),cts.Token);
            while(await reader.ReadLineAsync(cts.Token) is { } line)
            {
                var msg=JsonSerializer.Deserialize<PipeMessage>(line,Json.Options);
                if(msg?.Type=="auth-rejected")return null;
                if(msg?.Type=="cmd-ack" && msg.RequestId==requestId)return msg;
            }
        }
        catch(Exception) { /* Connection failure/timeout: caller must treat the outcome as unknown, without replay. */ }
        return null;
    }

    public void Dispose()
    {
        Stop();
        _stopCts?.Dispose();
    }

    private async Task ConnectLoop(CancellationToken cancellation)
    {
        while(!cancellation.IsCancellationRequested)
        {
            try
            {
                // Both values rotate after a daemon restart; never cache a rejected token.
                _port=ReadPort(_stateDir);
                var token=ReadAuthSecret(_stateDir);
                if(_port<=0 || token==null)
                {
                    await Task.Delay(500,cancellation);
                    continue;
                }
                using var client=new TcpClient();
                await client.ConnectAsync("127.0.0.1",_port,cancellation);
                using var stream=client.GetStream();
                using var writer=new StreamWriter(stream,new UTF8Encoding(false)){AutoFlush=true};
                using var reader=new StreamReader(stream,new UTF8Encoding(false));
                await writer.WriteLineAsync(JsonSerializer.Serialize(new { type="hello", token },Json.Options).AsMemory(),cancellation);
                await writer.WriteLineAsync("{\"type\":\"subscribe\"}".AsMemory(),cancellation);
                var received=false;
                while(!cancellation.IsCancellationRequested)
                {
                    var line=await reader.ReadLineAsync(cancellation);
                    if(line==null)break;
                    var msg=JsonSerializer.Deserialize<PipeMessage>(line,Json.Options);
                    if(msg==null)continue;
                    if(msg.Type=="auth-rejected")break;
                    if(!received)
                    {
                        received=true;
                        _connected=true;
                        OnReconnect?.Invoke();
                    }
                    switch(msg.Type)
                    {
                        case "state":
                            if(msg.State!=null)OnStateUpdate?.Invoke(msg.State);
                            break;
                        case "state-changed":
                            OnStateUpdate?.Invoke(_store.ReadTrayState());
                            break;
                        case "registry-changed":
                            OnRegistryReload?.Invoke();
                            break;
                        case "daemon-status":
                            var status=msg.Payload?.Status ?? msg.Status;
                            if(status!=null)OnDaemonStatus?.Invoke(status);
                            break;
                    }
                }
            }
            catch(OperationCanceledException) when(cancellation.IsCancellationRequested) { break; }
            catch(Exception) { /* Polling remains available; retry with fresh port/token. */ }
            finally { _connected=false; }
            try { await Task.Delay(500,cancellation); }
            catch(OperationCanceledException) { break; }
        }
    }

    /// <summary>M8 P0: Read the IPC auth secret for token-based authentication.</summary>
    private static string? ReadAuthSecret(string stateDir)
    {
        try
        {
            var secretFile=Path.Combine(stateDir,"ipc-auth.secret");
            if(File.Exists(secretFile))
            {
                var v=File.ReadAllText(secretFile).Trim();
                return v.Length>=32?v:null;
            }
        }
        catch{}
        return null;
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

public sealed class PipeMessage
{
    [System.Text.Json.Serialization.JsonPropertyName("type")]
    public string? Type { get; set; }
    [System.Text.Json.Serialization.JsonPropertyName("state")]
    public AttentionState? State { get; set; }
    [System.Text.Json.Serialization.JsonPropertyName("status")]
    public string? Status { get; set; }
    [System.Text.Json.Serialization.JsonPropertyName("payload")]
    public DaemonStatusPayload? Payload { get; set; }
    [System.Text.Json.Serialization.JsonPropertyName("requestId")]
    public string? RequestId { get; set; }
    [System.Text.Json.Serialization.JsonPropertyName("ok")]
    public bool? Ok { get; set; }
    [System.Text.Json.Serialization.JsonPropertyName("code")]
    public int? Code { get; set; }
    [System.Text.Json.Serialization.JsonPropertyName("error")]
    public string? Error { get; set; }
}

public sealed class DaemonStatusPayload
{
    [System.Text.Json.Serialization.JsonPropertyName("status")]
    public string? Status { get; set; }
}
