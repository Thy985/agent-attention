using System.Threading;
using System.Windows;
using System.Windows.Threading;
using AgentAttention.UI;
using System.IO;
using Application=System.Windows.Application;

internal static class Program
{
    private static string? _logPath;

    private static void Log(string message)
    {
        if (string.IsNullOrWhiteSpace(_logPath)) return;
        try
        {
            File.AppendAllText(_logPath, $"{DateTimeOffset.Now:O} {message}{Environment.NewLine}");
        }
        catch (IOException)
        {
        }
    }

    [STAThread]
    internal static int Main(string[] arguments)
    {
        UiOptions options;
        try
        {
            options=UiOptions.Parse(arguments);
        }
        catch(Exception)
        {
            return 64;
        }

        Mutex? trayMutex=null;
        Mutex? centerMutex=null;
        EventWaitHandle? activationEvent=null;
        TrayController? tray=null;

        try
        {
            _logPath=Environment.GetEnvironmentVariable("AGENT_ATTENTION_UI_LOG");
            Log("starting");
            trayMutex=new Mutex(false,options.TrayMutexName);
            if(!Acquire(trayMutex))
            {
                Log("tray mutex busy; signaling existing host");
                SignalExistingHost(options.ActivationEventName);
                return 0;
            }

            Log("tray mutex acquired");
            centerMutex=new Mutex(false,options.CenterMutexName);
            if(!AcquireWithRetry(centerMutex,TimeSpan.FromSeconds(2)))
            {
                Log("center mutex busy");
                Console.Error.WriteLine("Another Center window is already running.");
                return 2;
            }

            Log("center mutex acquired");
            activationEvent=new EventWaitHandle(false,EventResetMode.AutoReset,options.ActivationEventName);
            Log("activation event created");

            var store=new StateStore(options);
            // M6b: create IPC client first, then wrap commands with RPC+CLI fallback
            IpcClient? ipc=null;
            var stateDir=Path.GetDirectoryName(options.StatePath);
            if(!string.IsNullOrWhiteSpace(stateDir)&&IpcClient.CanConnect(stateDir))
            {
                ipc=new IpcClient(stateDir,store);
            }
            var cliRunner=new CliCommandRunner(options.CliPath);
            var commands=new CommandRunner(ipc,cliRunner.MarkAllRead,cliRunner.MarkRead,cliRunner.Jump);
            var window=new CenterWindow(store,commands);
            Log("window constructed");
            window.Closed+=(_,_)=>Log("window closed");
            window.IsVisibleChanged+=(sender,eventArgs)=>
            {
                if((bool)eventArgs.NewValue)
                {
                    Log("window visible");
                }
                else
                {
                    Log("window hidden");
                }
            };
            tray=new TrayController(
                store,
                commands,
                string.IsNullOrWhiteSpace(options.TrayStatePath)
                    ?Path.Combine(Path.GetDirectoryName(options.StatePath)??".","tray-state.json")
                    :options.TrayStatePath,
                options.StatePath);
            Log("tray constructed");
            tray.ShowCenterRequested+=(_,_)=>window.ShowAndActivate();
            tray.ExitRequested+=(_,_)=>Application.Current.Shutdown();
            Log("events attached");

            var application=new Application
            {
                ShutdownMode=ShutdownMode.OnExplicitShutdown,
            };
            Log("application constructed");
            application.DispatcherUnhandledException+=(_,eventArgs)=>
            {
                Log($"dispatcher exception: {eventArgs.Exception}");
                eventArgs.Handled=true;
            };

            var refreshTimer=new DispatcherTimer{Interval=TimeSpan.FromMilliseconds(2_000)};
            refreshTimer.Tick+=(_,_)=>
            {
                try
                {
                    window.Refresh();
                    var windowHandle=new System.Windows.Interop.WindowInteropHelper(window).Handle;
                    Log($"center refreshed visible={window.IsVisible} handle={windowHandle} windows={Application.Current.Windows.Count}");
                }
                catch(Exception exception)
                {
                    Log($"refresh exception: {exception}");
                }
            };
            refreshTimer.Start();
            Log("refresh timer started");

            var activationTimer=new DispatcherTimer{Interval=TimeSpan.FromMilliseconds(100)};
            activationTimer.Tick+=(_,_)=>
            {
                if(activationEvent.WaitOne(TimeSpan.Zero))
                {
                    Log("activation received");
                    window.ShowAndActivate();
                }
            };
            activationTimer.Start();
            Log("activation timer started");

            tray.Start();
            Log("tray started");
            if(options.OpenCenter)
            {
                window.ShowAndActivate();
                Log("open center requested");
            }

            Log("entering message loop");
            application.Run();
            Log("message loop exited");
            return 0;
        }
        catch(Exception exception)
        {
            Log($"exception: {exception}");
            return 1;
        }
        finally
        {
            tray?.Dispose();
            activationEvent?.Dispose();
            Release(centerMutex);
            centerMutex?.Dispose();
            Release(trayMutex);
            trayMutex?.Dispose();
        }
    }

    private static bool Acquire(Mutex mutex)
    {
        try
        {
            return mutex.WaitOne(TimeSpan.Zero,exitContext:true);
        }
        catch(AbandonedMutexException)
        {
            return true;
        }
    }

    private static bool AcquireWithRetry(Mutex mutex,TimeSpan timeout)
    {
        var deadline=DateTime.UtcNow+timeout;
        while(DateTime.UtcNow<deadline)
        {
            if(Acquire(mutex))return true;
            Thread.Sleep(50);
        }

        return Acquire(mutex);
    }

    private static void SignalExistingHost(string eventName)
    {
        for(var attempt=0;attempt<20;attempt++)
        {
            if(EventWaitHandle.TryOpenExisting(eventName,out var existing))
            {
                using(existing)
                {
                    existing.Set();
                }
                return;
            }

            Thread.Sleep(50);
        }
    }

    private static void Release(Mutex? mutex)
    {
        try
        {
            mutex?.ReleaseMutex();
        }
        catch(ApplicationException)
        {
        }
    }
}
