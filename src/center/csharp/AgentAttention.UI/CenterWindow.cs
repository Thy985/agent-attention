using System.Windows;
using System.Windows.Controls;
using System.Windows.Media;
using System.Windows.Automation.Peers;
using System.Windows.Automation.Provider;
using Application=System.Windows.Application;
using Brush=System.Windows.Media.Brush;
using Brushes=System.Windows.Media.Brushes;
using Button=System.Windows.Controls.Button;
using Color=System.Windows.Media.Color;
using Orientation=System.Windows.Controls.Orientation;

namespace AgentAttention.UI;

public sealed class CenterWindow : Window
{
    private readonly StateStore _store;
    private readonly CommandRunner _commands;
    private readonly TextBlock _header = new();
    private readonly StackPanel _eventList = new();
    private readonly List<string> _groupHeaders = new();
    private readonly List<string> _visibleEventIds = new();

    public CenterWindow(StateStore store, CommandRunner commands)
    {
        _store=store;
        _commands=commands;

        Title="Agent Attention Center";
        Width=520;
        Height=480;
        WindowStartupLocation=WindowStartupLocation.Manual;
        Background=new SolidColorBrush(Color.FromRgb(24,26,32));

        var markAllButton=new Button
        {
            Content="Mark all read",
            Padding=new Thickness(12,5,12,5),
            Background=new SolidColorBrush(Color.FromRgb(58,110,165)),
            Foreground=Brushes.White,
            BorderThickness=new Thickness(0),
        };
        markAllButton.Click+=(_,_)=>
        {
            _commands.MarkAllRead();
            Hide();
        };

        _header.Foreground=Brushes.White;
        _header.FontSize=17;
        _header.FontWeight=FontWeights.SemiBold;
        _header.Margin=new Thickness(0,0,12,0);

        var headerGrid=new Grid();
        headerGrid.ColumnDefinitions.Add(new ColumnDefinition{Width=new GridLength(1,GridUnitType.Star)});
        headerGrid.ColumnDefinitions.Add(new ColumnDefinition{Width=GridLength.Auto});
        Grid.SetColumn(_header,0);
        Grid.SetColumn(markAllButton,1);
        headerGrid.Children.Add(_header);
        headerGrid.Children.Add(markAllButton);

        var scrollViewer=new ScrollViewer
        {
            Margin=new Thickness(0,14,0,0),
            VerticalScrollBarVisibility=ScrollBarVisibility.Auto,
            Content=_eventList,
        };

        var root=new Grid{Margin=new Thickness(18)};
        root.RowDefinitions.Add(new RowDefinition{Height=GridLength.Auto});
        root.RowDefinitions.Add(new RowDefinition{Height=new GridLength(1,GridUnitType.Star)});
        Grid.SetRow(headerGrid,0);
        Grid.SetRow(scrollViewer,1);
        root.Children.Add(headerGrid);
        root.Children.Add(scrollViewer);
        Content=root;
    }

    public void ShowAndActivate()
    {
        Show();
        if(WindowState==WindowState.Minimized)
        {
            WindowState=WindowState.Normal;
        }
        Activate();
    }

    public void Refresh()
    {
        var snapshot=_store.ReadCenterSnapshot();
        UnreadCount=snapshot.State.UnreadCount;
        Title=snapshot.State.UnreadCount==0
            ?"Agent Attention Center"
            :$"Agent Attention Center ({snapshot.State.UnreadCount})";
        _header.Text=snapshot.State.UnreadCount==0
            ?"All caught up"
            :$"{snapshot.State.UnreadCount} unread";

        _eventList.Children.Clear();
        _groupHeaders.Clear();
        _visibleEventIds.Clear();

        var groups=snapshot.State.Events
            .GroupBy(item=>item.AgentId,StringComparer.Ordinal)
            .ToList();
        if(groups.Count==0)
        {
            _eventList.Children.Add(new TextBlock
            {
                Text="No events yet. Run agent-notify to trigger notifications.",
                Foreground=new SolidColorBrush(Color.FromRgb(150,155,165)),
                Margin=new Thickness(0,20,0,0),
            });
            return;
        }

        foreach(var group in groups)
        {
            var agent=snapshot.Registry.Agents.FirstOrDefault(item=>item.AgentId==group.Key);
            var agentName=agent?.Name??group.First().AgentName;
            var unread=group.Count(item=>!item.Read);
            var header=new Grid{Margin=new Thickness(0,8,0,4)};
            var title=new TextBlock
            {
                Text=$"{agentName} ({unread} unread)",
                Foreground=Brushes.White,
                FontWeight=FontWeights.SemiBold,
                VerticalAlignment=VerticalAlignment.Center,
            };
            header.Children.Add(title);

            if(agent?.Target?.Pid>0)
            {
                var focusButton=new Button
                {
                    Content="Focus",
                    Padding=new Thickness(7,2,7,2),
                    Margin=new Thickness(8,0,0,0),
                    HorizontalAlignment=System.Windows.HorizontalAlignment.Left,
                };
                Grid.SetColumn(focusButton,1);
                var agentId=group.Key;
                focusButton.Click+=(_,_)=>_commands.Jump(agentId);
                header.ColumnDefinitions.Add(new ColumnDefinition{Width=new GridLength(1,GridUnitType.Star)});
                header.ColumnDefinitions.Add(new ColumnDefinition{Width=GridLength.Auto});
                Grid.SetColumn(title,0);
                header.Children.Add(focusButton);
            }

            _groupHeaders.Add($"{agentName} ({unread} unread)");
            _eventList.Children.Add(header);

            foreach(var item in group.Take(8))
            {
                _visibleEventIds.Add(item.Id);
                _eventList.Children.Add(CreateEventCard(item,snapshot.Registry));
            }

            if(group.Count()>8)
            {
                _eventList.Children.Add(new TextBlock
                {
                    Text=$"…and {group.Count()-8} more",
                    Foreground=new SolidColorBrush(Color.FromRgb(120,124,134)),
                    Margin=new Thickness(8,0,0,6),
                });
            }
        }
    }

    public IReadOnlyList<string> VisibleGroupHeaders=>_groupHeaders;
    public IReadOnlyList<string> VisibleEventIds=>_visibleEventIds;

    public bool InvokeContentButton(string content)
    {
        return InvokeContentButton((DependencyObject)Content,content);
    }

    private bool InvokeContentButton(DependencyObject? parent,string content)
    {
        if(parent==null)return false;
        var count=VisualTreeHelper.GetChildrenCount(parent);
        for(var index=0;index<count;index++)
        {
            var child=VisualTreeHelper.GetChild(parent,index);
            if(child is Button button&&string.Equals(button.Content as string,content,StringComparison.Ordinal))
            {
                var peer=FrameworkElementAutomationPeer.CreatePeerForElement(button)
                    ??new ButtonAutomationPeer(button);
                if(peer.GetPattern(PatternInterface.Invoke)is IInvokeProvider provider)
                {
                    provider.Invoke();
                    return true;
                }

                button.RaiseEvent(new RoutedEventArgs(System.Windows.Controls.Primitives.ButtonBase.ClickEvent));
                return true;
            }

            if(InvokeContentButton(child,content))return true;
        }

        return false;
    }

    public int UnreadCount { get; private set; }

    protected override void OnClosing(System.ComponentModel.CancelEventArgs e)
    {
        if(Application.Current!=null&&!Application.Current.Dispatcher.HasShutdownStarted)
        {
            e.Cancel=true;
            Hide();
            return;
        }

        base.OnClosing(e);
    }

    private UIElement CreateEventCard(StateEvent item,AgentRegistry registry)
    {
        var agentName=registry.Agents.FirstOrDefault(agent=>agent.AgentId==item.AgentId)?.Name
            ??item.AgentName;
        var priorityColor=item.Priority=="P0"?Color.FromRgb(229,72,77):item.Priority=="P1"
            ?Color.FromRgb(230,145,56):Color.FromRgb(88,166,255);

        var title=new TextBlock
        {
            Text=$"{agentName} · {FormatAge(item.Timestamp)}",
            Foreground=new SolidColorBrush(priorityColor),
            FontWeight=FontWeights.SemiBold,
            TextTrimming=TextTrimming.CharacterEllipsis,
        };
        var message=new TextBlock
        {
            Text=item.Message,
            Foreground=new SolidColorBrush(Color.FromRgb(220,222,228)),
            Margin=new Thickness(0,4,0,0),
            TextWrapping=TextWrapping.Wrap,
        };
        var details=new StackPanel{Children={title,message}};

        var actions=new StackPanel{Orientation=Orientation.Horizontal};
        if(registry.Agents.FirstOrDefault(agent=>agent.AgentId==item.AgentId)?.Target is AgentTarget target&&target.Pid>0)
        {
            var jumpButton=new Button
            {
                Content="Focus",
                Padding=new Thickness(7,2,7,2),
                Margin=new Thickness(0,0,6,0),
            };
            jumpButton.Click+=(_,_)=>_commands.Jump(item.AgentId);
            actions.Children.Add(jumpButton);
        }

        var readButton=new Button
        {
            Content="Mark read",
            Padding=new Thickness(7,2,7,2),
        };
        var eventId=item.Id;
        readButton.Click+=(_,_)=>_commands.MarkRead(eventId);
        actions.Children.Add(readButton);

        var cardGrid=new Grid();
        cardGrid.ColumnDefinitions.Add(new ColumnDefinition{Width=new GridLength(1,GridUnitType.Star)});
        cardGrid.ColumnDefinitions.Add(new ColumnDefinition{Width=GridLength.Auto});
        Grid.SetColumn(details,0);
        Grid.SetColumn(actions,1);
        cardGrid.Children.Add(details);
        cardGrid.Children.Add(actions);

        return new Border
        {
            Background=new SolidColorBrush(Color.FromRgb(33,37,45)),
            CornerRadius=new CornerRadius(7),
            Padding=new Thickness(11),
            Margin=new Thickness(0,0,0,9),
            Child=cardGrid,
        };
    }

    private static string FormatAge(long timestampMilliseconds)
    {
        var elapsed=DateTimeOffset.Now.ToUnixTimeMilliseconds()-timestampMilliseconds;
        if(elapsed<60_000)return "just now";
        if(elapsed<3_600_000)return $"{elapsed/60_000}m ago";
        if(elapsed<86_400_000)return $"{elapsed/3_600_000}h ago";
        return $"{elapsed/86_400_000}d ago";
    }
}

