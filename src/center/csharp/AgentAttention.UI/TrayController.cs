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
    private readonly WinForms.NotifyIcon _notifyIcon=new();
    private readonly DispatcherTimer _refreshTimer=new();
    private readonly DateTime _startedAt=DateTime.UtcNow;
    private bool _suppressClick;
    private bool _trayFileSeen;
    private string _lastSignature=string.Empty;
    private Icon? _icon;
    private IntPtr _iconHandle;

    public event EventHandler? ShowCenterRequested;
    public event EventHandler? ExitRequested;

    public TrayController(StateStore store,CommandRunner commands,string trayStatePath,string statePath)
    {
        _store=store;
        _commands=commands;
        _trayStatePath=trayStatePath;
        _daemonPidPath=Path.Combine(Path.GetDirectoryName(statePath)??".","daemon.pid");

        _notifyIcon.Text="Agent Attention";
        _notifyIcon.Visible=false;
        _notifyIcon.Click+=(_,_)=>OnNotifyIconClick();
        _notifyIcon.DoubleClick+=(_,_)=>
        {
            _suppressClick=true;
            _commands.MarkAllRead();
        };

        _refreshTimer.Interval=TimeSpan.FromMilliseconds(500);
        _refreshTimer.Tick+=(_,_)=>Refresh();
    }

    public void Start()
    {
        Refresh();
        _refreshTimer.Start();
    }

    public void Stop()
    {
        _refreshTimer.Stop();
        _notifyIcon.Visible=false;
    }

    public void Refresh()
    {
        if(!CheckLifecycle())return;

        var state=_store.ReadTrayState();
        if(File.Exists(_trayStatePath))_trayFileSeen=true;

        var signature=$"{state.Visible}|{state.UnreadCount}|{string.Join("|",state.Events.Select(item=>$"{item.Id}:{item.Read}"))}";
        if(signature==_lastSignature)return;
        _lastSignature=signature;

        UpdateIcon(state);
        UpdateMenu(state);
        _notifyIcon.Visible=state.Visible||state.UnreadCount>0;
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
            if(process.HasExited)
            {
                RequestExit();
                return false;
            }
        }
        catch(Exception)
        {
            RequestExit();
            return false;
        }

        return true;
    }

    private void OnNotifyIconClick()
    {
        if(_suppressClick)
        {
            _suppressClick=false;
            return;
        }

        ShowCenterRequested?.Invoke(this,EventArgs.Empty);
    }

    private void UpdateIcon(AttentionState state)
    {
        using var bitmap=new Bitmap(16,16);
        using(var graphics=Graphics.FromImage(bitmap))
        {
            graphics.SmoothingMode=System.Drawing.Drawing2D.SmoothingMode.AntiAlias;
            using var background=new SolidBrush(state.UnreadCount>0?Color.FromArgb(229,72,77):Color.FromArgb(88,166,255));
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
        _notifyIcon.Text=state.UnreadCount==0?"Agent Attention — no unread":$"Agent Attention — {state.UnreadCount} unread";
    }

    private static FontStyle Bold=>FontStyle.Bold;

    private void UpdateMenu(AttentionState state)
    {
        var menu=new WinForms.ContextMenuStrip();
        menu.Items.Add("Open Center",null,(_,_)=>ShowCenterRequested?.Invoke(this,EventArgs.Empty));

        foreach(var item in state.Events.Where(item=>!item.Read).Take(10))
        {
            var eventId=item.Id;
            menu.Items.Add($"Mark read — {item.Title}",null,(_,_)=>_commands.MarkRead(eventId));
        }

        menu.Items.Add(new WinForms.ToolStripSeparator());
        menu.Items.Add("Exit",null,(_,_)=>RequestExit());
        _notifyIcon.ContextMenuStrip=menu;
    }

    private void RequestExit()=>ExitRequested?.Invoke(this,EventArgs.Empty);

    public void Dispose()
    {
        Stop();
        _notifyIcon.Dispose();
        _icon?.Dispose();
        if(_iconHandle!=IntPtr.Zero)
        {
            NativeMethods.DestroyIcon(_iconHandle);
            _iconHandle=IntPtr.Zero;
        }
    }
}
