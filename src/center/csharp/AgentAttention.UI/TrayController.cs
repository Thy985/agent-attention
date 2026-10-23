using System;
using System.Drawing;
using System.IO;
using System.Windows.Threading;
using WinForms=System.Windows.Forms;

namespace AgentAttention.UI;

public sealed class TrayController : IDisposable
{
    private readonly StateStore _store;
    private readonly CommandRunner _commands;
    private readonly string _trayStatePath;
    private readonly string _daemonPidPath;
    private readonly IpcClient? _ipc;
    private readonly WinForms.NotifyIcon _notifyIcon=new();
    private readonly DispatcherTimer _refreshTimer=new();
    private readonly DateTime _startedAt=DateTime.UtcNow;
    private readonly Dispatcher _dispatcher=Dispatcher.CurrentDispatcher;
    private bool _stopped;
    private bool _trayFileSeen;
    private string _lastSignature=string.Empty;
    private readonly OwnedResource<WinForms.ContextMenuStrip> _menu = new();
    private Icon? _icon;
    private IntPtr _iconHandle;

    public event EventHandler? ShowCenterRequested;
    public event EventHandler? ExitRequested;

    public TrayController(StateStore store, CommandRunner commands,
        string trayStatePath, string statePath)
    {
        _store=store;
        _commands=commands;
        _trayStatePath=trayStatePath;
        _daemonPidPath=Path.Combine(Path.GetDirectoryName(statePath)??".","daemon.pid");

        _commands.Completed += OnCommandCompleted;
        _notifyIcon.Text="Agent Attention";
        _notifyIcon.Visible=false;
        _notifyIcon.MouseClick+=(_,e)=>{ if(e.Button==WinForms.MouseButtons.Left) OnNotifyIconClick(); };
        _notifyIcon.MouseDoubleClick+=(_,e)=>
        {
            if(e.Button==WinForms.MouseButtons.Left) ShowCenterRequested?.Invoke(this,EventArgs.Empty);
        };

        _refreshTimer.Interval=TimeSpan.FromMilliseconds(500);
        _refreshTimer.Tick+=(_,_)=>
        {
            // Keep lifecycle checks and the file fallback alive during disconnects.
            Refresh();
        };

        // Try to connect via IPC if port file exists
        var stateDir=Path.GetDirectoryName(statePath);
        if(!string.IsNullOrWhiteSpace(stateDir) && IpcClient.CanConnect(stateDir))
        {
            _ipc=new IpcClient(stateDir, store);
            _ipc.OnStateUpdate+=OnIpcStateUpdate;
            _ipc.OnReconnect+=OnIpcReconnect;
            _ipc.OnDaemonStatus+=OnIpcDaemonStatus;
        }
    }

    private void OnCommandCompleted(CommandOutcome outcome)
    {
        if (_stopped || outcome.Ok == true) return;
        RunOnUi(() => _notifyIcon.ShowBalloonTip(5000, "Agent Attention", outcome.Message, WinForms.ToolTipIcon.Warning));
    }

    public void Start()
    {
        _stopped=false;
        _ipc?.Start();
        Refresh();
        _refreshTimer.Start();
    }

    public void Stop()
    {
        _stopped=true;
        _refreshTimer.Stop();
        _ipc?.Stop();
        _notifyIcon.Visible=false;
    }

    public void Refresh()
    {
        if(!CheckLifecycle())return;

        var snapshot=_store.ReadTraySnapshot();
        var state=snapshot.State;
        if(File.Exists(_trayStatePath))_trayFileSeen=true;

        var signature=$"{snapshot.Error}|{snapshot.HasSnapshot}|{state.Visible}|{state.UnreadCount}|{string.Join("|",state.Events.Select(item=>$"{item.Id}:{item.Read}"))}";
        if(signature==_lastSignature)return;
        _lastSignature=signature;

        UpdateIcon(snapshot);
        UpdateMenu(snapshot);
        _notifyIcon.Visible=true;
    }

    /// <summary>M6a: reconnected after disconnect — rebuild full snapshot from state.json.</summary>
    private void OnIpcReconnect()=>RunOnUi(Refresh);

    /// <summary>M6a: daemon sent stopping signal — exit gracefully.</summary>
    private void OnIpcDaemonStatus(string status)
    {
        if(status=="stopping")RunOnUi(RequestExit);
    }

    // Both the initial/full IPC state and lightweight change notifications refresh the same
    // validated file projection. Polling continues while connected, so errors can recover
    // even when no further IPC change notification arrives.
    private void OnIpcStateUpdate(AttentionState state)=>RunOnUi(Refresh);

    // IpcClient callbacks run on a worker; NotifyIcon and menus belong to the UI thread.
    private void RunOnUi(Action action)
    {
        if(_stopped)return;
        if(_dispatcher.CheckAccess())action();
        else _dispatcher.BeginInvoke(new Action(()=>{if(!_stopped)action();}));
    }

    private bool CheckLifecycle()
    {
        var trayFileExists=File.Exists(_trayStatePath);
        if(trayFileExists)
        {
            _trayFileSeen=true;
            return true;
        }

        var elapsed=(DateTime.UtcNow-_startedAt).TotalMilliseconds;
        if(!_trayFileSeen&&elapsed<2_000)return true;
        if(_trayFileSeen)
        {
            RequestExit();
            return false;
        }

        if(!File.Exists(_daemonPidPath))
        {
            RequestExit();
            return false;
        }

        try
        {
            var pid=int.Parse(File.ReadAllText(_daemonPidPath).Trim());
            using var process=System.Diagnostics.Process.GetProcessById(pid);
            return !process.HasExited;
        }
        catch(Exception)
        {
            RequestExit();
            return false;
        }
    }

    private void OnNotifyIconClick()
    {
        ShowCenterRequested?.Invoke(this,EventArgs.Empty);
    }

    private void UpdateIcon(TraySnapshot snapshot)
    {
        var state = snapshot.State;
        using var bitmap=new Bitmap(16,16);
        using(var graphics=Graphics.FromImage(bitmap))
        {
            graphics.SmoothingMode=System.Drawing.Drawing2D.SmoothingMode.AntiAlias;
            using var background=new SolidBrush(
                snapshot.Error != null ? Color.FromArgb(210,145,45) :
                state.UnreadCount>0?Color.FromArgb(229,72,77):Color.FromArgb(88,166,255));
            graphics.FillEllipse(background,1,1,14,14);
            if(state.UnreadCount>0)
            {
                using var font=new Font("Segoe UI",7f,Bold);
                using var format=new StringFormat{Alignment=StringAlignment.Center,LineAlignment=StringAlignment.Center};
                using var textBrush=new SolidBrush(Color.White);
                graphics.DrawString(state.UnreadCount.ToString(),font,textBrush,8,8,format);
            }
        }

        if(_iconHandle!=IntPtr.Zero)
        {
            NativeMethods.DestroyIcon(_iconHandle);
            _iconHandle=IntPtr.Zero;
        }

        _icon?.Dispose();
        _iconHandle=bitmap.GetHicon();
        _icon=Icon.FromHandle(_iconHandle);
        _notifyIcon.Icon=_icon;
        _notifyIcon.Text=snapshot.Error != null
            ? (snapshot.HasSnapshot ? $"Agent Attention — stale: {state.UnreadCount} unread" : "Agent Attention — data unavailable")
            : state.UnreadCount==0
            ?"Agent Attention — no unread"
            :$"Agent Attention — {state.UnreadCount} unread";
    }

    private static FontStyle Bold=>FontStyle.Bold;

    private void UpdateMenu(TraySnapshot snapshot)
    {
        var state = snapshot.State;
        var menu=new WinForms.ContextMenuStrip();
        menu.Items.Add("Open Center",null,(_,_)=>ShowCenterRequested?.Invoke(this,EventArgs.Empty));

        if (snapshot.Error != null)
        {
            var warning = menu.Items.Add(snapshot.HasSnapshot
                ? "Data unavailable — last snapshot shown" : "Data unavailable — no snapshot yet");
            warning.Enabled = false;
        }

        foreach(var item in state.Events.Where(item=>!item.Read).Take(10))
        {
            var eventId=item.Id;
            var read = menu.Items.Add($"Mark read — {item.Title}",null,(_,_)=>_commands.MarkRead(eventId));
            read.Enabled = snapshot.Error == null;
        }

        var markAll = menu.Items.Add("Mark all notifications read",null,(_,_)=>_commands.MarkAllRead());
        markAll.Enabled = snapshot.Error == null && state.UnreadCount > 0;
        menu.Items.Add(new WinForms.ToolStripSeparator());
        menu.Items.Add("Exit",null,(_,_)=>RequestExit());
        _notifyIcon.ContextMenuStrip=menu;
        _menu.Replace(menu);
    }

    private void RequestExit()=>ExitRequested?.Invoke(this,EventArgs.Empty);

    public void Dispose()
    {
        Stop();
        _commands.Completed -= OnCommandCompleted;
        _notifyIcon.ContextMenuStrip=null;
        _menu.Dispose();
        _notifyIcon.Dispose();
        _icon?.Dispose();
        if(_iconHandle!=IntPtr.Zero)
        {
            NativeMethods.DestroyIcon(_iconHandle);
            _iconHandle=IntPtr.Zero;
        }
    }
}
