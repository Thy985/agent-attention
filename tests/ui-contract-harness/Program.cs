using System.Text.Json;
using AgentAttention.UI;

// Production logic only; this does not simulate WPF or claim desktop/assistive-technology acceptance.
int passed = 0;
void Check(bool condition, string name) { if (!condition) throw new Exception(name); Console.WriteLine("PASS " + name); passed++; }
var root = Path.Combine(Path.GetTempPath(), "aa-ui-contract-" + Guid.NewGuid().ToString("N"));
Directory.CreateDirectory(root);
try
{
    var item = JsonSerializer.Deserialize<StateEvent>("""
      {"id":"e1","type":"failed","read":false,"session_id":"s1","task_id":"t1",
       "source_event":"exit","evidence":{"scope":"process","basis":"process_observation","mechanism":"wrapper","contract":"wrapper.v1"}}
      """, Json.Options)!;
    Check(item.SessionId == "s1" && item.TaskId == "t1" && item.Evidence?.Contract == "wrapper.v1", "deserialize session/task/evidence without dropping metadata");
    Check(EventPresentation.Label(item).Contains("TASK OUTCOME UNKNOWN"), "process failure is not labelled task failure");
    Check(EventPresentation.Details(item).Contains("Session: s1") && EventPresentation.Details(item).Contains("Source: exit"), "source and session are visible in presentation");
    Check(EventPresentation.Label(new StateEvent { Type = "nonsense" }) == "UNKNOWN EVENT", "unknown event never becomes DONE");
    Check(EventPresentation.Label(new StateEvent { Type = "completed" }).Contains("SCOPE UNKNOWN"), "legacy completion not promoted to verified task success");
    Check(EventPresentation.Label(new StateEvent { Type = "completed", Evidence = new() { Scope = "turn" } }).Contains("TASK OUTCOME UNKNOWN"), "turn ending is not task completion");
    Check(EventPresentation.Label(new StateEvent { Type = "permission_required" }) != EventPresentation.Label(new StateEvent { Type = "input_required" }), "permission and input requests distinguished");
    var sorted = EventPresentation.Order(new[] {
        new StateEvent { Id = "done", Type = "completed", Timestamp = 4 },
        new StateEvent { Id = "read-request", Type = "input_required", Timestamp = 5, Read = true },
        new StateEvent { Id = "action", Type = "permission_required", Timestamp = 1 },
        new StateEvent { Id = "fail", Type = "failed", Timestamp = 2 },
    }).Select(e => e.Id).ToArray();
    Check(string.Join(",", sorted) == "action,done,fail,read-request", "unread action first, chronological within groups, read last");

    int cliCalls = 0, rpcCalls = 0;
    var runner = new CommandRunner(() => true,
        (_, _) => { rpcCalls++; return Task.FromResult<PipeMessage?>(new() { Ok = true }); },
        (_, _) => { cliCalls++; return Task.FromResult(CommandOutcome.Success("ok")); });
    Check((await runner.MarkReadAsync("e1")).Ok == true && rpcCalls == 1 && cliCalls == 0, "ack success returned to caller without fallback");
    var failure = new CommandRunner(() => true, (_, _) => Task.FromResult<PipeMessage?>(new() { Ok = false }),
        (_, _) => { cliCalls++; return Task.FromResult(CommandOutcome.Success("wrong")); });
    Check((await failure.JumpAsync("a")).Ok == false && cliCalls == 0, "explicit rejection is shown without replay");
    var unknown = new CommandRunner(() => true, (_, _) => Task.FromResult<PipeMessage?>(null),
        (_, _) => { cliCalls++; return Task.FromResult(CommandOutcome.Success("wrong")); });
    Check((await unknown.JumpAsync("a")).Ok == null && cliCalls == 0, "lost acknowledgement is unknown, never a duplicate jump");
    var thrown = new CommandRunner(() => true, (_, _) => throw new IOException("private data"),
        (_, _) => { cliCalls++; return Task.FromResult(CommandOutcome.Success("wrong")); });
    var uncertain = await thrown.JumpAsync("a");
    Check(uncertain.Ok == null && !uncertain.Message.Contains("private") && cliCalls == 0, "transport exception contained without private output or replay");
    var gate = new TaskCompletionSource<CommandOutcome>();
    var offline = new CommandRunner(() => false, (_, _) => throw new Exception("must not send"), (_, _) => gate.Task);
    var pending = offline.MarkAllReadAsync();
    Check(!pending.IsCompleted, "command stays pending until CLI acknowledges");
    gate.SetResult(CommandOutcome.Success("saved"));
    Check((await pending).Ok == true, "CLI completion awaited");
    int feedback = 0; offline.Completed += _ => feedback++;
    await offline.MarkReadAsync("e1");
    Check(feedback == 1, "tray and center can observe a single final outcome");

    var script = Path.Combine(root, "fake-cli.js");
    File.WriteAllText(script, "process.exit(process.argv[2] === 'jump' ? 1 : 0);");
    var cli = new CliCommandRunner(script);
    Check((await cli.RunAsync("mark-event", new[] { "event with spaces" })).Ok == true, "real CLI zero exit accepted with argument-list invocation");
    Check((await cli.RunAsync("jump", new[] { "a" })).Ok == false, "real CLI nonzero exit visible as failure");
    Check((await new CliCommandRunner("").RunAsync("jump", new[] { "a" })).Ok == false, "missing command path not silently treated as success");

    var options = new UiOptions { StatePath = Path.Combine(root,"state.json"), RegistryPath = Path.Combine(root,"agents.json"), TrayStatePath = Path.Combine(root,"tray.json") };
    var store = new StateStore(options);
    Check(store.ReadCenterSnapshot().Error != null, "missing data is not All caught up");
    File.WriteAllText(options.StatePath, "{\"version\":1,\"unreadCount\":0,\"events\":[{\"id\":\"e1\",\"read\":false}]}");
    Check(store.ReadCenterSnapshot().State.UnreadCount == 1, "display unread count derived from persisted events");
    File.WriteAllText(options.StatePath, "broken");
    var stale = store.ReadCenterSnapshot();
    Check(stale.Error != null && stale.State.Events.Count == 1, "corrupt state preserves last snapshot with warning");
    File.WriteAllText(options.StatePath, "{\"version\":1,\"events\":[]}");
    Check(store.ReadCenterSnapshot().Error == null, "successful refresh clears unavailable state");
    File.WriteAllText(options.RegistryPath, "{\"agents\":null}");
    Check(store.ReadCenterSnapshot().Error != null, "invalid registry visible as unavailable rather than false empty state");
    // File projections, not a fake JS copy: these invoke production StateStore directly.
    File.Delete(options.RegistryPath);
    File.Delete(options.StatePath);
    var noData = new StateStore(options).ReadTraySnapshot();
    Check(noData.Error != null && !noData.HasSnapshot, "tray first read without data is unavailable, not no-unread success");
    File.WriteAllText(options.StatePath, "{\"version\":1,\"events\":[{\"id\":\"primary\",\"read\":false}]}");
    var tray = new StateStore(options);
    Check(tray.ReadTraySnapshot().State.UnreadCount == 1, "missing projection may use valid primary state");
    File.WriteAllText(options.TrayStatePath, "{\"version\":1,\"unreadCount\":99,\"events\":[{\"id\":\"tray\",\"read\":false}]}");
    Check(tray.ReadTraySnapshot().State.Events[0].Id == "tray" && tray.ReadTraySnapshot().State.UnreadCount == 1, "valid projection wins and unread count is derived");
    File.WriteAllText(options.TrayStatePath, "{broken");
    var corruptTray = tray.ReadTraySnapshot();
    Check(corruptTray.Error != null && corruptTray.HasSnapshot && corruptTray.State.Events[0].Id == "tray", "corrupt projection retains last projection rather than hiding error behind primary");
    Check(File.ReadAllText(options.TrayStatePath) == "{broken", "tray reader never rewrites corrupt evidence");
    foreach (var invalid in new[] { "null", "{}", "[]", "{\"version\":2,\"events\":[]}", "{\"version\":\"1\",\"events\":[]}",
        "{\"version\":1,\"events\":null}", "{\"version\":1,\"events\":[null]}", "{\"version\":1,\"events\":[{\"id\":\"\"}]}" })
    {
        File.WriteAllText(options.TrayStatePath, invalid);
        var bad = tray.ReadTraySnapshot();
        Check(bad.Error != null && bad.State.Events[0].Id == "tray", "invalid tray shape safely retains known events: " + invalid);
    }
    File.WriteAllText(options.TrayStatePath, "{\"version\":1,\"events\":[]}");
    Check(tray.ReadTraySnapshot() is { Error: null, HasSnapshot: true, State.UnreadCount: 0 }, "valid empty refresh clears error, unlike malformed empty data");
    Exception? readError = null;
    var injected = new StateStore(options, p => readError == null ? File.ReadAllText(p) : throw readError);
    injected.ReadTraySnapshot();
    readError = new IOException("private-path");
    var ioSnapshot = injected.ReadTraySnapshot();
    Check(ioSnapshot.Error != null && !ioSnapshot.Error.Contains("private-path") && ioSnapshot.HasSnapshot, "I/O exception handled inside reader without leaking paths");
    readError = new UnauthorizedAccessException("private-path");
    Check(injected.ReadTraySnapshot().Error != null, "permission failure handled without clearing cached state");
    readError = null;
    Check(injected.ReadTraySnapshot().Error == null, "reader recovers after I/O access returns");
    // Actual file disappearance between existence check and read is modelled at the read boundary.
    var vanished = new StateStore(options, p => { File.Delete(p); return File.ReadAllText(p); }).ReadTraySnapshot();
    Check(vanished.Error != null && !vanished.HasSnapshot, "file removal race is unavailable, not an uncaught timer exception");

    // The production resource owner is used by TrayController. This measures deterministic
    // ownership, not V8 GC timing and not Windows GDI handle counts.
    var owner = new OwnedResource<DisposableProbe>();
    var resources = new List<DisposableProbe>();
    for (int i = 0; i < 50; i++)
    {
        var next = new DisposableProbe();
        resources.Add(next);
        owner.Replace(next);
        Check(resources.Take(i).All(r => r.Disposals == 1) && next.Disposals == 0, $"menu ownership cycle {i}: previous disposed once, current live");
    }
    owner.Replace(owner.Current);
    Check(resources[^1].Disposals == 0, "same menu assignment does not dispose the live menu");
    owner.Dispose(); owner.Dispose();
    Check(owner.Current == null && resources.All(r => r.Disposals == 1), "all fifty owned menus disposed exactly once including final menu");
    bool refused = false;
    var unused = new DisposableProbe();
    try { owner.Replace(unused); } catch (ObjectDisposedException) { refused = true; }
    Check(refused && unused.Disposals == 0, "disposed owner refuses transfer; caller retains rejected resource");
    unused.Dispose();
    Console.WriteLine($"{passed} UI contract assertions passed (no Windows rendering or GDI handle-count claims).");
}
finally { Directory.Delete(root, true); }

sealed class DisposableProbe : IDisposable { public int Disposals; public void Dispose() => Disposals++; }

namespace AgentAttention.UI {
    public sealed class UiOptions {
        public string StatePath { get; init; } = "";
        public string RegistryPath { get; init; } = "";
        public string TrayStatePath { get; init; } = "";
    }
}
