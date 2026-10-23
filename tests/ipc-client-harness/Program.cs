using System.Net;
using System.Net.Sockets;
using System.Text;
using System.Text.Json;
using AgentAttention.UI;

// No WPF substitute: exercise the production IPC client and StateStore on real TCP.
// Only UiOptions (which calls WindowsIdentity) is replaced with paths for this harness.
var root=Path.Combine(Path.GetTempPath(),"aa-client-"+Guid.NewGuid().ToString("N"));
Directory.CreateDirectory(root);
var options=new UiOptions { StatePath=Path.Combine(root,"state.json"), RegistryPath=Path.Combine(root,"agents.json"), TrayStatePath=Path.Combine(root,"tray-state.json") };
File.WriteAllText(options.StatePath,"{\"version\":1,\"events\":[]}");
var store=new StateStore(options);
var passed=0;
void Check(bool condition,string name) { if(!condition)throw new Exception(name); Console.WriteLine("PASS "+name); passed++; }
async Task WaitFor(Func<bool> predicate) {
    using var timeout=new CancellationTokenSource(4000);
    while(!predicate())await Task.Delay(10,timeout.Token);
}
TcpListener Listen(string token) {
    var server=new TcpListener(IPAddress.Loopback,0); server.Start();
    File.WriteAllText(Path.Combine(root,"ipc-port.txt"),((IPEndPoint)server.LocalEndpoint).Port.ToString());
    File.WriteAllText(Path.Combine(root,"ipc-auth.secret"),token);
    return server;
}
try {
    var token=new string('a',64);
    using(var server=Listen(token)) {
        var accept=Task.Run(async()=>{
            using var socket=await server.AcceptTcpClientAsync();
            using var stream=socket.GetStream();
            using var reader=new StreamReader(stream);
            using var writer=new StreamWriter(stream,new UTF8Encoding(false)){AutoFlush=true};
            using var hello=JsonDocument.Parse((await reader.ReadLineAsync())!);
            Check(hello.RootElement.GetProperty("type").GetString()=="hello" && hello.RootElement.GetProperty("token").GetString()==token,"RPC authenticates before command");
            using var cmd=JsonDocument.Parse((await reader.ReadLineAsync())!);
            Check(cmd.RootElement.GetProperty("command").GetString()=="mark-event" && cmd.RootElement.GetProperty("args")[0].GetString()=="中文","RPC preserves command and Unicode args");
            var id=cmd.RootElement.GetProperty("requestId").GetString();
            await writer.WriteLineAsync(JsonSerializer.Serialize(new { type="cmd-ack",requestId="not-this-request",ok=false }));
            await writer.WriteLineAsync(JsonSerializer.Serialize(new { type="cmd-ack",requestId=id,ok=true,code=0 }));
        });
        using var client=new IpcClient(root,store);
        var result=await client.SendCommand("mark-event","中文");
        await accept;
        Check(result?.Ok==true,"RPC reads matching ack on its own socket (without subscription)");
        Check(!client.IsConnected,"configured port alone does not mean connected");
    }
    using(var server=Listen(token)) {
        var accept=Task.Run(async()=>{
            using var socket=await server.AcceptTcpClientAsync();
            using var stream=socket.GetStream();
            using var reader=new StreamReader(stream);
            using var writer=new StreamWriter(stream,new UTF8Encoding(false)){AutoFlush=true};
            await reader.ReadLineAsync(); await reader.ReadLineAsync();
            await writer.WriteLineAsync("{\"type\":\"auth-rejected\"}");
        });
        using var client=new IpcClient(root,store);
        var result=await client.SendCommand("mark-all-read");
        await accept;
        Check(result==null,"RPC handles auth rejection");
    }
    using(var server=Listen(token)) {
        using var client=new IpcClient(root,store);
        var statuses=new List<string>();
        var count=0; var lastUnread=-1;
        client.OnDaemonStatus+=status=>{lock(statuses)statuses.Add(status);};
        client.OnStateUpdate+=state=>{Interlocked.Exchange(ref lastUnread,state.UnreadCount); Interlocked.Increment(ref count);};
        client.Start();
        using var socket=await server.AcceptTcpClientAsync().WaitAsync(TimeSpan.FromSeconds(4));
        using var stream=socket.GetStream();
        using var reader=new StreamReader(stream);
        using var writer=new StreamWriter(stream,new UTF8Encoding(false)){AutoFlush=true};
        await reader.ReadLineAsync(); await reader.ReadLineAsync();
        await writer.WriteLineAsync("{\"type\":\"daemon-status\",\"payload\":{\"status\":\"alive\"}}");
        await WaitFor(()=>client.IsConnected);
        await WaitFor(()=>{lock(statuses)return statuses.Contains("alive");});
        Check(true,"subscription reads nested daemon-status payload");
        File.WriteAllText(options.TrayStatePath,"{\"version\":1,\"unreadCount\":99,\"events\":[{\"id\":\"one\",\"read\":false},{\"id\":\"two\",\"read\":false},{\"id\":\"three\",\"read\":false}]}");
        await writer.WriteLineAsync("{\"type\":\"state-changed\",\"payload\":{\"file\":\"state\"}}");
        await WaitFor(()=>Volatile.Read(ref count)>0);
        Check(Volatile.Read(ref lastUnread)==3,"state-changed reloads persisted state rather than ignoring it");
        // Rotate both files and force a reconnect. Production code must re-read BOTH.
        var rotated=new string('b',64);
        using var replacement=Listen(rotated);
        socket.Close(); server.Stop();
        using var reconnected=await replacement.AcceptTcpClientAsync().WaitAsync(TimeSpan.FromSeconds(4));
        using var nextStream=reconnected.GetStream();
        using var nextReader=new StreamReader(nextStream);
        using var nextWriter=new StreamWriter(nextStream,new UTF8Encoding(false)){AutoFlush=true};
        using var hello=JsonDocument.Parse((await nextReader.ReadLineAsync())!);
        Check(hello.RootElement.GetProperty("token").GetString()==rotated,"reconnect reloads rotated port and token");
        await nextReader.ReadLineAsync();
        await nextWriter.WriteLineAsync("{\"type\":\"daemon-status\",\"payload\":{\"status\":\"alive\"}}");
        await WaitFor(()=>client.IsConnected);
        client.Stop();
        Check(!client.IsConnected,"Stop clears connection state");
        var eof=await nextReader.ReadLineAsync().WaitAsync(TimeSpan.FromSeconds(2));
        Check(eof==null,"Stop cancels blocked socket read and closes connection");
    }
    Console.WriteLine($"{passed} client regression assertions passed.");
} finally { Directory.Delete(root,true); }

namespace AgentAttention.UI {
    public sealed class UiOptions {
        public string StatePath { get; init; }="";
        public string RegistryPath { get; init; }="";
        public string TrayStatePath { get; init; }="";
    }
}
