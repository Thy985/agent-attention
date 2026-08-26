using System.IO;
using System.Text.Json;
using System.Windows;
using System.Windows.Threading;
using AgentAttention.UI;

internal static class Program
{
    private static int _passed;
    private static int _failed;

    [STAThread]
    internal static int Main()
    {
        var application=new Application{ShutdownMode=ShutdownMode.OnExplicitShutdown};
        var root=Directory.CreateTempSubdirectory("agent-attention-ui-harness-").FullName;
        try
        {
            ZeroUnread(root);
            OneUnread(root);
            TwoUnreadAndMarkAll(root);
            ThreeAgentsAndEventTypes(root);
            PerAgentLimit(root);
            MarkEventAndJump(root);
            CloseHidesWhileHostRemains(root);
        }
        catch(Exception exception)
        {
            Fail("harness completed without exception",exception.ToString());
        }
        finally
        {
            application.Shutdown();
            try{Directory.Delete(root,true);}catch(IOException){}
        }

        Console.WriteLine($"M1 interaction harness: passed={_passed} failed={_failed}");
        return _failed==0?0:1;
    }

    private static void ZeroUnread(string root)
    {
        var scenario=CreateScenario(Path.Combine(root,"zero-unread"),new[]
        {
            Event("read-1","codex","completed",true),
        });
        scenario.Window.Refresh();
        AssertEqual(0,scenario.Window.UnreadCount,"zero unread/title");
        AssertEqual("Codex (0 unread)",scenario.Window.VisibleGroupHeaders.Single(),"zero unread/group");
        AssertEqual(1,scenario.Window.VisibleEventIds.Count,"zero unread/event retained");
    }

    private static void OneUnread(string root)
    {
        var scenario=CreateScenario(Path.Combine(root,"one-unread"),new[]
        {
            Event("unread-1","codex","input_required",false),
            Event("read-1","claude","completed",true),
        },agents:new[]{Agent("codex"),Agent("claude")});
        scenario.Window.Refresh();
        AssertEqual(1,scenario.Window.UnreadCount,"one unread/count");
        AssertSequence(new[]{"Codex (1 unread)","Claude (0 unread)"},scenario.Window.VisibleGroupHeaders,"one unread/groups");
    }

    private static void TwoUnreadAndMarkAll(string root)
    {
        var scenario=CreateScenario(Path.Combine(root,"two-unread-mark-all"),new[]
        {
            Event("mark-all-2","codex","permission_required",false),
            Event("mark-all-1","claude","completed",false),
        },agents:new[]{Agent("codex"),Agent("claude")});
        scenario.Window.Refresh();
        AssertEqual(2,scenario.Window.UnreadCount,"mark-all initial");
        scenario.Window.ShowAndActivate();
        AssertTrue(scenario.Window.InvokeContentButton("Mark all read"),"mark-all AutomationPeer invoke");
        WaitFor(()=>!scenario.Window.IsVisible,"mark-all hides Center");
        AssertFalse(scenario.Window.IsVisible,"mark-all closes/hides Center");

        WaitFor(()=>StateUnreadCount(scenario.StatePath)==0,"mark-all state update");
        scenario.Window.Refresh();
        AssertEqual(0,scenario.Window.UnreadCount,"mark-all refreshed count");
        AssertContains("\"mark-all-read\"",File.ReadAllText(scenario.CommandLog),"mark-all CLI invocation");
    }

    private static void ThreeAgentsAndEventTypes(string root)
    {
        var scenario=CreateScenario(Path.Combine(root,"three-agents"),new[]
        {
            Event("evt-permission","codex","permission_required",false,"Codex"),
            Event("evt-input","claude","input_required",false,"Claude"),
            Event("evt-failed","gemini","failed",false,"Gemini"),
            Event("evt-complete","codex","completed",true,"Codex"),
        },agents:new[]{Agent("codex"),Agent("claude"),Agent("gemini")});
        scenario.Window.Refresh();

        AssertEqual(3,scenario.Window.UnreadCount,"three agents/unread");
        AssertSequence(new[]{"Codex (1 unread)","Claude (1 unread)","Gemini (1 unread)"},scenario.Window.VisibleGroupHeaders,"three agents/groups");
        AssertSequence(new[]{"evt-permission","evt-complete","evt-input","evt-failed"},scenario.Window.VisibleEventIds,"three agents/order");
    }

    private static void PerAgentLimit(string root)
    {
        var events=Enumerable.Range(1,10).Select(index=>Event($"cap-{index:00}","codex","completed",index>8)).ToList();
        var scenario=CreateScenario(Path.Combine(root,"per-agent-limit"),events);
        scenario.Window.Refresh();
        AssertEqual(8,scenario.Window.VisibleEventIds.Count,"agent limit/visible");
        AssertEqual("cap-01",scenario.Window.VisibleEventIds.First(),"agent limit/newest first");
        AssertEqual("cap-08",scenario.Window.VisibleEventIds.Last(),"agent limit/cutoff");
    }

    private static void MarkEventAndJump(string root)
    {
        var scenario=CreateScenario(Path.Combine(root,"commands"),new[]
        {
            Event("command-read","codex","failed",false),
        },agents:new[]{Agent("codex",targetPid:1234)});
        scenario.Window.Refresh();
        scenario.Window.ShowAndActivate();

        AssertTrue(scenario.Window.InvokeContentButton("Focus"),"Focus AutomationPeer invoke");
        AssertTrue(scenario.Window.InvokeContentButton("Mark read"),"Mark read AutomationPeer invoke");
        WaitFor(()=>File.ReadAllText(scenario.CommandLog).Contains("\"jump\""),"jump CLI invocation");
        WaitFor(()=>File.ReadAllText(scenario.CommandLog).Contains("\"mark-event\""),"mark-event CLI invocation");
        WaitFor(()=>EventIsRead(scenario.StatePath,"command-read"),"mark-event state update");
    }

    private static void CloseHidesWhileHostRemains(string root)
    {
        var scenario=CreateScenario(Path.Combine(root,"close-hide"),Array.Empty<StateFixture>());
        scenario.Window.Refresh();
        scenario.Window.ShowAndActivate();
        AssertTrue(scenario.Window.IsVisible,"close/window shown");
        scenario.Window.Close();
        AssertFalse(scenario.Window.IsVisible,"close/window hidden");
    }

    private static Scenario CreateScenario(
        string directory,
        IEnumerable<StateFixture> events,
        AgentFixture[]? agents=null)
    {
        Directory.CreateDirectory(directory);
        agents??=new[]{Agent("codex")};
        var state=new
        {
            version=1,
            updatedAt=DateTimeOffset.Now.ToUnixTimeMilliseconds(),
            unreadCount=events.Count(item=>!item.read),
            visible=events.Any(item=>!item.read),
            events,
        };
        var registry=new{agents};
        var statePath=Path.Combine(directory,"state.json");
        var registryPath=Path.Combine(directory,"agents.json");
        var commandLog=Path.Combine(directory,"cli-calls.log");
        File.WriteAllText(statePath,JsonSerializer.Serialize(state,new JsonSerializerOptions{WriteIndented=true}));
        File.WriteAllText(registryPath,JsonSerializer.Serialize(registry));
        File.WriteAllText(commandLog,string.Empty);
        File.WriteAllText(Path.Combine(directory,"fake-cli.js"),
            """
            const fs = require('fs');
            const path = require('path');
            const [command, argument] = process.argv.slice(2);
            const statePath = path.join(__dirname, 'state.json');
            const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
            if (command === 'mark-all-read') {
              state.events.forEach(event => { event.read = true; });
              state.unreadCount = 0;
              state.visible = false;
            } else if (command === 'mark-event') {
              const event = state.events.find(item => item.id === argument);
              if (event && !event.read) { state.unreadCount--; event.read = true; }
              state.visible = state.unreadCount > 0;
            }
            fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
            fs.appendFileSync(path.join(__dirname, 'cli-calls.log'), JSON.stringify(process.argv.slice(2)) + '\n');
            """);

        var options=UiOptions.Parse(new[]
        {
            "-StatePath",statePath,
            "-RegistryPath",registryPath,
            "-CliPath",Path.Combine(directory,"fake-cli.js"),
            "-TrayStatePath",statePath,
        });
        return new Scenario(
            new CenterWindow(new StateStore(options),new CommandRunner(options.CliPath)),
            statePath,
            commandLog);
    }

    private static StateFixture Event(string id,string agentId,string type,bool read,string agentName="Codex")
    {
        return new StateFixture(
            id,
            DateTimeOffset.Now.ToUnixTimeMilliseconds(),
            type,
            type=="permission_required"||type=="input_required"?"P0":type=="failed"?"P1":"P2",
            agentId,
            agentName,
            $"{type}: {id}",
            $"{id} message",
            read);
    }

    private static AgentFixture Agent(string id,int? targetPid=null)
    {
        var name=id.ToLowerInvariant() switch
        {
            "codex"=>"Codex",
            "claude"=>"Claude",
            "gemini"=>"Gemini",
            _=>id,
        };
        return new AgentFixture(id,name,DateTimeOffset.Now.ToUnixTimeMilliseconds(),targetPid);
    }

    private static int StateUnreadCount(string path)
    {
        using var document=JsonDocument.Parse(File.ReadAllText(path));
        return document.RootElement.GetProperty("unreadCount").GetInt32();
    }

    private static bool EventIsRead(string path,string id)
    {
        using var document=JsonDocument.Parse(File.ReadAllText(path));
        foreach(var item in document.RootElement.GetProperty("events").EnumerateArray())
        {
            if(item.GetProperty("id").GetString()==id)return item.GetProperty("read").GetBoolean();
        }

        return false;
    }

    private static void WaitFor(Func<bool> condition,string description)
    {
        for(var attempt=0;attempt<50;attempt++)
        {
            try{if(condition())return;}catch(IOException){}
            PumpDispatcher(100);
        }

        Fail(description,"condition was not met within 5 seconds");
    }

    private static void PumpDispatcher(int milliseconds)
    {
        var deadline=Environment.TickCount64+milliseconds;
        while(Environment.TickCount64<deadline)
        {
            var frame=new DispatcherFrame();
            Dispatcher.CurrentDispatcher.BeginInvoke(DispatcherPriority.Background,new Action(()=>frame.Continue=false));
            Dispatcher.PushFrame(frame);
            Thread.Sleep(10);
        }
    }

    private static void AssertTrue(bool condition,string name)=>AssertEqual(true,condition,name);
    private static void AssertFalse(bool condition,string name)=>AssertEqual(false,condition,name);

    private static void AssertEqual<T>(T expected,T actual,string name)
    {
        if(Equals(expected,actual))
        {
            _passed++;
            Console.WriteLine($"PASS {name}");
            return;
        }

        Fail(name,$"expected={expected} actual={actual}");
    }

    private static void AssertSequence(IReadOnlyList<string> expected,IReadOnlyList<string> actual,string name)
    {
        if(expected.SequenceEqual(actual,StringComparer.Ordinal))
        {
            _passed++;
            Console.WriteLine($"PASS {name}");
            return;
        }

        Fail(name,$"expected=[{string.Join(',',expected)}] actual=[{string.Join(',',actual)}]");
    }

    private static void AssertContains(string expected,string actual,string name)=>AssertTrue(actual.Contains(expected,StringComparison.Ordinal),name);

    private static void Fail(string name,string detail)
    {
        _failed++;
        Console.Error.WriteLine($"FAIL {name}: {detail}");
    }

    private sealed record StateFixture(
        string id,long timestamp,string type,string priority,string agent_id,string agent_name,string title,string message,bool read);
    private sealed class AgentFixture
    {
        public AgentFixture(string agentId,string name,long lastSeenAt,int? targetPid)
        {
            agent_id=agentId;
            this.name=name;
            this.last_seen_at=lastSeenAt;
            target=targetPid.HasValue?new{type="terminal",pid=targetPid.Value}:null;
        }

        public string agent_id { get; }
        public string name { get; }
        public long last_seen_at { get; }
        public object? target { get; }
    }

    private sealed record Scenario(CenterWindow Window,string StatePath,string CommandLog);
}

