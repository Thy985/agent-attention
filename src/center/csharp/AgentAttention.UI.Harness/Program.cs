using System.IO;
using System.Text.Json;
using System.Windows;
using System.Windows.Automation.Peers;
using System.Windows.Automation.Provider;
using System.Windows.Controls;
using System.Windows.Media;
using System.Windows.Threading;
using AgentAttention.UI;

// Interactive Windows runner only. Fake CLI tests UI feedback/wiring, never real focus or Toast delivery.
internal static class Program
{
    private static int _passed, _failed;
    private static long _timestamp = DateTimeOffset.Now.ToUnixTimeMilliseconds();
    [STAThread]
    internal static int Main()
    {
        var application = new Application { ShutdownMode = ShutdownMode.OnExplicitShutdown };
        var root = Directory.CreateTempSubdirectory("agent-attention-ui-harness-").FullName;
        try
        {
            BasicDisplay(root);
            MarkAllKeepsFeedbackVisible(root);
            EventOrderingAndLimit(root);
            ReadAndFocusAreDifferent(root);
            UnchangedRefreshKeepsControl(root);
            UnavailableDataDoesNotLookEmpty(root);
            CloseHidesWhileHostRemains(root);
            TrayDegradationAndMenuOwnership(root);
        }
        catch (Exception exception) { Fail("harness completed without exception", exception.ToString()); }
        finally
        {
            application.Shutdown();
            try { Directory.Delete(root, true); } catch (IOException) { }
        }
        Console.WriteLine($"Windows UI interaction harness: passed={_passed} failed={_failed}. Fake CLI; no real desktop focus/Toast acceptance.");
        return _failed == 0 ? 0 : 1;
    }

    private static void BasicDisplay(string root)
    {
        var scenario = CreateScenario(Path.Combine(root,"display"),new[] {
            Event("permission","codex","permission_required",false),
            Event("complete","claude","completed",true),
        },new[] { Agent("codex"),Agent("claude") });
        Assert(scenario.Window.Title.EndsWith("(1)"),"unread count in window title");
        Assert(HasText(scenario.Window,"PERMISSION REQUESTED"),"permission is not generic ACTION");
        Assert(HasText(scenario.Window,"COMPLETION REPORTED — SCOPE UNKNOWN"),"legacy completion scope is explicit");
        Assert(HasText(scenario.Window,"completed: complete"),"event title displayed");
        Assert(HasText(scenario.Window,"Read") && HasText(scenario.Window,"Unread"),"read state visible without colour alone");
        Assert(Controls(scenario.Window).OfType<Button>().Any(b=>b.Focusable && b.Uid=="agent:codex"),"agent filter is a focusable button");
    }

    private static void MarkAllKeepsFeedbackVisible(string root)
    {
        var scenario = CreateScenario(Path.Combine(root,"mark-all"),new[] {
            Event("one","codex","input_required",false),Event("two","claude","completed",false),
        });
        Assert(Invoke(scenario.Window,"Mark all read"),"mark all via AutomationPeer");
        WaitFor(()=>HasText(scenario.Window,"Read state saved."),"mark-all result feedback");
        Assert(scenario.Window.IsVisible,"mark-all does not hide the outcome");
        Assert(ReadState(scenario.StatePath).GetProperty("unreadCount").GetInt32()==0,"read update persisted");
        Assert(HasText(scenario.Window,"No unread notifications"),"count refreshed after acknowledgement");
    }

    private static void EventOrderingAndLimit(string root)
    {
        var ordered = CreateScenario(Path.Combine(root,"ordering"),new[] {
            Event("ordinary","codex","failed",false),Event("request","claude","input_required",false),
            Event("read","codex","completed",true),
        });
        Assert(string.Join(',',ordered.Window.VisibleEventIds)=="request,ordinary,read","unread request before other events; read last");
        var limited = CreateScenario(Path.Combine(root,"limit"),Enumerable.Range(1,25)
            .Select(i=>Event($"e{i:00}","codex","completed",false)).ToArray());
        Assert(limited.Window.VisibleEventIds.Count==20,"current UI cap is 20, not obsolete per-agent eight");
    }

    private static void ReadAndFocusAreDifferent(string root)
    {
        var scenario = CreateScenario(Path.Combine(root,"commands"),new[] { Event("event","codex","failed",false) },new[] { Agent("codex",1234) });
        Assert(Invoke(scenario.Window,"Focus"),"Focus via AutomationPeer");
        WaitFor(()=>HasText(scenario.Window,"Window focus confirmed."),"fake CLI success reaches UI");
        Assert(!ReadState(scenario.StatePath).GetProperty("events")[0].GetProperty("read").GetBoolean(),"Focus alone does not mark read");
        Assert(Invoke(scenario.Window,"Mark read"),"Mark read via AutomationPeer");
        WaitFor(()=>HasText(scenario.Window,"Read state saved."),"read action reaches final feedback");
        Assert(Controls(scenario.Window).OfType<Button>().Any(b=>Equals(b.Content,"Focus")),"read event retains return-to-window action");
        Assert(File.ReadAllLines(scenario.CommandLog).Length==2,"one CLI operation per UI action");
    }

    private static void UnchangedRefreshKeepsControl(string root)
    {
        var scenario = CreateScenario(Path.Combine(root,"refresh"),new[] { Event("keep","codex","failed",false) });
        var button = Controls(scenario.Window).OfType<Button>().First(b=>Equals(b.Content,"Mark read"));
        scenario.Window.Refresh();
        Assert(Controls(scenario.Window).OfType<Button>().Any(b=>ReferenceEquals(b,button)),"unchanged poll keeps existing button instance");
    }

    private static void UnavailableDataDoesNotLookEmpty(string root)
    {
        var scenario = CreateScenario(Path.Combine(root,"corrupt"),new[] { Event("keep","codex","failed",false) });
        File.WriteAllText(scenario.StatePath,"invalid");
        scenario.Window.Refresh();
        Assert(HasText(scenario.Window,"Current data unavailable"),"invalid data not All caught up");
        Assert(scenario.Window.VisibleEventIds.Contains("keep"),"last available cards preserved");
        Assert(!Controls(scenario.Window).OfType<Button>().First(b=>Equals(b.Content,"Mark all read")).IsEnabled,"unavailable data disables write actions");
    }

    private static void CloseHidesWhileHostRemains(string root)
    {
        var scenario=CreateScenario(Path.Combine(root,"close"),Array.Empty<StateFixture>());
        scenario.Window.Close(); Pump(100);
        Assert(!scenario.Window.IsVisible,"closing Center hides it without stopping host");
    }

    private static void TrayDegradationAndMenuOwnership(string root)
    {
        // Real WinForms menus and production TrayController on a Windows runner.
        // IsDisposed is a deterministic lifetime assertion, not a GDI handle-count claim.
        var directory = Path.Combine(root, "tray"); Directory.CreateDirectory(directory);
        var state = Path.Combine(directory, "tray-state.json");
        void Write(int i) => File.WriteAllText(state, JsonSerializer.Serialize(new {
            version = 1, events = new[] { new { id = $"e{i}", read = false, title = $"event-{i}" } }
        }));
        Write(0);
        var options = UiOptions.Parse(new[] { "-StatePath", state, "-RegistryPath", Path.Combine(directory,"agents.json"), "-TrayStatePath", state });
        var controller = new TrayController(new StateStore(options), new CommandRunner(null, new CliCommandRunner("")), state, state);
        var icon = (System.Windows.Forms.NotifyIcon) typeof(TrayController)
            .GetField("_notifyIcon", System.Reflection.BindingFlags.NonPublic | System.Reflection.BindingFlags.Instance)!.GetValue(controller)!;
        System.Windows.Forms.ContextMenuStrip? finalMenu = null;
        try
        {
            controller.Refresh();
            var menus = new List<System.Windows.Forms.ContextMenuStrip> { icon.ContextMenuStrip! };
            for (int i = 1; i <= 50; i++)
            {
                Write(i); controller.Refresh();
                Assert(menus[^1].IsDisposed, $"real tray refresh {i} disposes previous ContextMenuStrip");
                menus.Add(icon.ContextMenuStrip!);
            }
            File.WriteAllText(state, "broken"); controller.Refresh();
            Assert(icon.Text.Contains("stale"), "tray tooltip reports stale data instead of no unread");
            Assert(icon.ContextMenuStrip!.Items.Cast<System.Windows.Forms.ToolStripItem>()
                .Where(i=>i.Text?.StartsWith("Mark ")==true).All(i=>!i.Enabled), "stale tray disables read actions");
            Assert(icon.ContextMenuStrip.Items[0].Enabled, "Open Center remains available during data error");
            Write(51); controller.Refresh();
            Assert(!icon.Text.Contains("stale") && icon.ContextMenuStrip!.Items.Cast<System.Windows.Forms.ToolStripItem>()
                .Any(i=>i.Text?.StartsWith("Mark read")==true && i.Enabled), "tray recovers on valid refresh");
            finalMenu = icon.ContextMenuStrip;
        }
        finally { controller.Dispose(); }
        Assert(finalMenu?.IsDisposed==true, "tray disposal disposes last real menu");
    }

    private static Scenario CreateScenario(string directory,StateFixture[] events,AgentFixture[]? agents=null)
    {
        Directory.CreateDirectory(directory);
        agents??=new[] {Agent("codex")};
        var statePath=Path.Combine(directory,"state.json");
        var registryPath=Path.Combine(directory,"agents.json");
        var commandLog=Path.Combine(directory,"cli-calls.log");
        File.WriteAllText(statePath,JsonSerializer.Serialize(new {version=1,updatedAt=DateTimeOffset.Now.ToUnixTimeMilliseconds(),unreadCount=events.Count(e=>!e.read),visible=events.Any(e=>!e.read),events}));
        File.WriteAllText(registryPath,JsonSerializer.Serialize(new {agents}));
        File.WriteAllText(commandLog,string.Empty);
        var cliPath=Path.Combine(directory,"fake-cli.js");
        File.WriteAllText(cliPath,"""
            const fs = require('fs');
            const path = require('path');
            const [command, id] = process.argv.slice(2);
            const p = path.join(__dirname, 'state.json');
            const state = JSON.parse(fs.readFileSync(p, 'utf8'));
            if (command === 'mark-all-read') state.events.forEach(e => e.read = true);
            if (command === 'mark-event') { const e = state.events.find(e => e.id === id); if (e) e.read = true; }
            state.unreadCount = state.events.filter(e => !e.read).length;
            fs.writeFileSync(p, JSON.stringify(state));
            fs.appendFileSync(path.join(__dirname, 'cli-calls.log'), JSON.stringify(process.argv.slice(2)) + '\n');
            """);
        var options=UiOptions.Parse(new[] {"-StatePath",statePath,"-RegistryPath",registryPath,"-CliPath",cliPath,"-TrayStatePath",statePath});
        var window=new CenterWindow(new StateStore(options),new CommandRunner(null,new CliCommandRunner(cliPath)));
        window.Refresh(); window.ShowAndActivate(); window.UpdateLayout();
        return new(window,statePath,commandLog);
    }

    private static IEnumerable<DependencyObject> Controls(DependencyObject root)
    {
        yield return root;
        foreach(var child in LogicalTreeHelper.GetChildren(root).OfType<DependencyObject>())
            foreach(var descendant in Controls(child)) yield return descendant;
    }
    private static bool HasText(Window window,string text)=>Controls(window).OfType<TextBlock>().Any(b=>b.Text==text);
    private static bool Invoke(Window window,string content)
    {
        var button=Controls(window).OfType<Button>().FirstOrDefault(b=>Equals(b.Content,content));
        if(button==null||!button.IsEnabled)return false;
        var peer=new ButtonAutomationPeer(button);
        if(peer.GetPattern(PatternInterface.Invoke) is not IInvokeProvider invoke)return false;
        invoke.Invoke(); return true;
    }
    private static JsonElement ReadState(string path)=>JsonSerializer.Deserialize<JsonElement>(File.ReadAllText(path));
    private static void WaitFor(Func<bool> condition,string name)
    {
        for(var i=0;i<60;i++) { try {if(condition()){_passed++;Console.WriteLine("PASS "+name);return;}} catch(IOException){} Pump(100); }
        Fail(name,"timeout after 6 seconds");
    }
    private static void Pump(int milliseconds)
    {
        var deadline=Environment.TickCount64+milliseconds;
        while(Environment.TickCount64<deadline)
        {
            var frame=new DispatcherFrame();
            Dispatcher.CurrentDispatcher.BeginInvoke(DispatcherPriority.Background,new Action(()=>frame.Continue=false));
            Dispatcher.PushFrame(frame);Thread.Sleep(10);
        }
    }
    private static void Assert(bool condition,string name) {if(condition){_passed++;Console.WriteLine("PASS "+name);}else Fail(name,"false");}
    private static void Fail(string name,string detail){_failed++;Console.Error.WriteLine($"FAIL {name}: {detail}");}
    private static StateFixture Event(string id,string agent,string type,bool read)=>new(id,Interlocked.Decrement(ref _timestamp),type,"P2",agent,agent,$"{type}: {id}","Example message",read);
    private static AgentFixture Agent(string id,int? pid=null)=>new(id,id,DateTimeOffset.Now.ToUnixTimeMilliseconds(),pid.HasValue?new {type="terminal",pid=pid.Value}:null);
    private sealed record StateFixture(string id,long timestamp,string type,string priority,string agent_id,string agent_name,string title,string message,bool read);
    private sealed record AgentFixture(string agent_id,string name,long last_seen_at,object? target);
    private sealed record Scenario(CenterWindow Window,string StatePath,string CommandLog);
}
