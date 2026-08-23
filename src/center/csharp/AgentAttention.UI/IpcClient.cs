using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
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
///   "cmd-ack"            -> server response; drives pending TaskCompletionSource
/// </summary>
public sealed class IpcClient : IDisposable
{
    private readonly string _stateDir;
    private readonly StateStore _store;
    private bool _running;
    private Task? _connectTask;
    private int _port;
    private readonly Dictionary<string, TaskCompletionSource<PipeMessage>> _pendingCommands = new();
    private string? _token;

    public event Action<AttentionState>? OnStateUpdate;
    public event Action? OnRegistryReload;
    public event Action<string>? OnDaemonStatus;
    /// <summary>Emitted each time the connection is re-established after a disconnect.</summary>
    public event Action? OnReconnect;

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
        _token=ReadAuthSecret(stateDir);
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

    /// <summary>M6b: Send a command via IPC and wait for ack. Returns null on timeout/failure.</summary>
    public async Task<PipeMessage?> SendCommand(string command, params string[] args)
    {
        if(_port<=0)return null;
        var requestId=Guid.NewGuid().ToString("N")[..8];
        var tcs=new TaskCompletionSource<PipeMessage>();
        _pendingCommands[requestId]=tcs;
        try
        {
            using var client=new TcpClient();
            await client.ConnectAsync("127.0.0.1",_port);
            using var stream=client.GetStream();
            using var writer=new StreamWriter(stream,new UTF8Encoding(false)){AutoFlush=true};
            var payload=new { type="cmd", requestId, command, args };
            var json=JsonSerializer.Serialize(payload,Json.Options);
            await writer.WriteLineAsync(json);
            using var cts=new CancellationTokenSource(5000);
            cts.Token.Register(()=>{
                if(_pendingCommands.Remove(requestId,out var failed))
                    failed.SetResult(null!);
            });
            return await tcs.Task;
        }
        catch(Exception)
        {
            if(_pendingCommands.Remove(requestId,out var failed))
                failed.SetResult(null!);
            return null;
        }
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
                // M8 P0: auth handshake before subscribe
                await writer.WriteLineAsync("{\"type\":\"hello\",\"token\":\""+_token+"\"}");
                await writer.WriteLineAsync("{\"type\":\"subscribe\"}");
                while(_running && client.Connected)
                {
                    var line=await reader.ReadLineAsync();
                    if(line==null)break;
                    try
                    {
                        var msg=JsonSerializer.Deserialize<PipeMessage>(line,Json.Options);
                        if(msg==null)continue;
                        switch(msg.Type)
                        {
                            case "state":
                            case "state-changed":
                                if(msg.State!=null)OnStateUpdate?.Invoke(msg.State);
                                break;
                            case "registry-changed":
                                OnRegistryReload?.Invoke();
                                break;
                            case "daemon-status":
                                if(msg.Status!=null)OnDaemonStatus?.Invoke(msg.Status);
                                break;
                            case "auth-rejected":
                                _running=false;
                                break;
                            case "cmd-ack":
                                if(msg.RequestId!=null
                                    && _pendingCommands.Remove(msg.RequestId,out var tcs))
                                    tcs.SetResult(msg);
                                break;
                        }
                    }
                    catch{}
                }
                await Task.Delay(500);
                // M6a: reconnect → TrayController rebuilds full snapshot
                OnReconnect?.Invoke();
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
    [System.Text.Json.Serialization.JsonPropertyName("requestId")]
    public string? RequestId { get; set; }
    [System.Text.Json.Serialization.JsonPropertyName("ok")]
    public bool? Ok { get; set; }
    [System.Text.Json.Serialization.JsonPropertyName("code")]
    public int? Code { get; set; }
    [System.Text.Json.Serialization.JsonPropertyName("error")]
    public string? Error { get; set; }
}
