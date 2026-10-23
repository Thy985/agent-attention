using System.Collections.Generic;
using System.Text.Json;
using System.Threading.Tasks;
using System.Windows.Automation;
using System.Windows.Automation.Peers;
using System.Linq;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Input;
using System.Windows.Media;
using System.Windows.Shapes;
using WpfApplication = System.Windows.Application;
using WpfBrushes = System.Windows.Media.Brushes;
using WpfButton = System.Windows.Controls.Button;
using WpfColor = System.Windows.Media.Color;
using WpfCursor = System.Windows.Input.Cursors;
using WpfEllipse = System.Windows.Shapes.Ellipse;
using WpfOrientation = System.Windows.Controls.Orientation;

namespace AgentAttention.UI;

public sealed class CenterWindow : Window
{
    private readonly StateStore _store;
    private readonly CommandRunner _commands;
    private readonly TextBlock _title = new();
    private readonly StackPanel _agentList = new();
    private readonly StackPanel _eventList = new();
    private readonly List<string> _visibleEventIds = new();
    private string? _selectedAgentId;
    private readonly TextBlock _connection = new() { TextWrapping = TextWrapping.Wrap, Margin = new Thickness(14, 4, 14, 0), FontSize = 11 };
    private readonly TextBlock _status = new() { TextWrapping = TextWrapping.Wrap, Margin = new Thickness(14, 8, 14, 8), FontSize = 12 };
    private readonly WpfButton _markAllButton = new();
    private string? _renderSignature;
    private int _pendingCommands;
    private bool _dataUnavailable;


    public CenterWindow(StateStore store, CommandRunner commands)
    {
        _store = store;
        _commands = commands;

        Title = "Agent Attention Center";
        Width = 640;
        Height = 560;
        MinWidth = 480;
        MinHeight = 340;
        ResizeMode = ResizeMode.CanResize;
        WindowStartupLocation = WindowStartupLocation.CenterScreen;
        Background = new SolidColorBrush(WpfColor.FromRgb(20, 22, 28));

        var markAllButton = _markAllButton;
        ConfigureMarkAllButton(markAllButton);
        markAllButton.Click += async (_, _) => await RunActionAsync(markAllButton, "Saving read state…", _commands.MarkAllReadAsync);
        AutomationProperties.SetName(markAllButton, "Mark all notifications read. This does not resolve tasks.");

        var headerGrid = new Grid();
        headerGrid.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
        headerGrid.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        _title.Foreground = WpfBrushes.White;
        _title.FontSize = 15;
        _title.FontWeight = FontWeights.SemiBold;
        _title.VerticalAlignment = VerticalAlignment.Center;
        Grid.SetColumn(_title, 0);
        Grid.SetColumn(markAllButton, 1);
        headerGrid.Children.Add(_title);
        headerGrid.Children.Add(markAllButton);

        var headerBorder = new Border
        {
            Child = headerGrid,
            BorderBrush = new SolidColorBrush(WpfColor.FromRgb(45, 50, 60)),
            BorderThickness = new Thickness(0, 0, 0, 1),
            Margin = new Thickness(14, 14, 14, 0),
            Padding = new Thickness(0, 0, 0, 10),
        };

        var agentScroll = new ScrollViewer
        {
            VerticalScrollBarVisibility = ScrollBarVisibility.Auto,
            MaxHeight = 140,
            ToolTip = "Agents — select a name to filter notifications",
            Background = null,
            BorderThickness = new Thickness(0),
            Padding = new Thickness(0),
            Margin = new Thickness(0, 0, 14, 0),
            Content = _agentList,
        };

        var agentsPanel = new Border
        {
            Child = agentScroll,
            BorderBrush = new SolidColorBrush(WpfColor.FromRgb(45, 50, 60)),
            BorderThickness = new Thickness(0),
            Margin = new Thickness(0, 0, 0, 0),
        };

        var eventsLabel = new TextBlock
        {
            Text = "RECENT ATTENTION",
            Foreground = new SolidColorBrush(WpfColor.FromRgb(165, 175, 190)),
            FontSize = 10,
            FontWeight = FontWeights.Bold,
            Margin = new Thickness(14, 10, 0, 4),
        };

        var eventScroll = new ScrollViewer
        {
            Margin = new Thickness(0, 2, 14, 14),
            VerticalScrollBarVisibility = ScrollBarVisibility.Auto,
            Background = null,
            BorderThickness = new Thickness(0),
            Content = _eventList,
        };

        var root = new Grid();
        root.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });
        root.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });
        root.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });
        root.RowDefinitions.Add(new RowDefinition { Height = new GridLength(1, GridUnitType.Star) });
        root.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });

        Grid.SetRow(headerBorder, 0);
        Grid.SetRow(agentsPanel, 1);
        Grid.SetRow(eventsLabel, 2);
        Grid.SetRow(eventScroll, 3);
        root.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });
        Grid.SetRow(_connection, 4);
        Grid.SetRow(_status, 5);
        AutomationProperties.SetLiveSetting(_status, AutomationLiveSetting.Polite);

        root.Children.Add(headerBorder);
        root.Children.Add(agentsPanel);
        root.Children.Add(eventsLabel);
        root.Children.Add(eventScroll);
        root.Children.Add(_connection);
        root.Children.Add(_status);

        Content = root;

        PreviewKeyDown += (_, e) =>
        {
            if (e.Key == Key.Escape) { Hide(); e.Handled = true; }
        };
    }

    public void ShowAndActivate()
    {
        Show();
        if (WindowState == WindowState.Minimized) WindowState = WindowState.Normal;
        Activate();
    }

    public void Refresh()
    {
        _connection.Text = _commands.IsConnected ? "Live updates connected"
            : "Live updates disconnected — showing saved local data; commands use the local CLI.";
        _connection.Foreground = _commands.IsConnected ? WpfBrushes.LightGray : WpfBrushes.Orange;
        var snapshot = _store.ReadCenterSnapshot();
        UpdateTitle(snapshot.State.UnreadCount);
        _dataUnavailable = snapshot.Error != null;
        _eventList.IsEnabled = !_dataUnavailable && _pendingCommands == 0;
        _markAllButton.IsEnabled = !_dataUnavailable && snapshot.State.UnreadCount > 0 && _pendingCommands == 0;
        if (_dataUnavailable)
        {
            _title.Text = "Current data unavailable";
            var errorChanged = _status.Text != snapshot.Error;
            _status.Text = snapshot.Error;
            _status.Foreground = WpfBrushes.Orange;
            if (errorChanged) AnnounceStatus();
            return;
        }
        if (_status.Text.StartsWith("Cannot load current data"))
        {
            _status.Text = "Connection to local data restored.";
            _status.Foreground = WpfBrushes.LightGray;
            AnnounceStatus();
        }
        // Unchanged polling must not destroy the focused button or its keyboard focus every two seconds.
        var signature = JsonSerializer.Serialize(new { snapshot.State, snapshot.Registry, _selectedAgentId,
            Minute = DateTimeOffset.Now.ToUnixTimeSeconds() / 60 }, Json.Options);
        if (signature == _renderSignature || _pendingCommands > 0) return;
        _renderSignature = signature;
        var focusId = (Keyboard.FocusedElement as FrameworkElement)?.Uid;
        RenderAgents(snapshot.Agents);
        RenderEvents(snapshot.State.Events, snapshot.Registry);
        if (!string.IsNullOrEmpty(focusId))
            FindFocusable(this, focusId)?.Focus();
    }

    private void UpdateTitle(int unreadCount)
    {
        Title = unreadCount == 0
            ? "Agent Attention Center"
            : $"Agent Attention Center ({unreadCount})";
        _title.Text = unreadCount == 0
            ? "No unread notifications"
            : $"{unreadCount} unread";
    }

    private void RenderAgents(List<AgentSummary> agents)
    {
        _agentList.Children.Clear();

        if (agents.Count == 0)
        {
            _agentList.Children.Add(new TextBlock
            {
                Text = "No agents registered yet",
                Foreground = new SolidColorBrush(WpfColor.FromRgb(165, 175, 190)),
                FontSize = 12,
                Margin = new Thickness(0, 8, 0, 0),
            });
            return;
        }

        foreach (var agent in agents)
            _agentList.Children.Add(BuildAgentCard(agent));
    }

    private UIElement BuildAgentCard(AgentSummary agent)
    {
        var hasUnread = agent.UnreadCount > 0;
        var isSelected = _selectedAgentId == agent.AgentId;
        var dotColor = hasUnread
            ? WpfColor.FromRgb(255, 118, 125)
            : WpfColor.FromRgb(88, 166, 255);

        var dot = new WpfEllipse
        {
            Width = 8, Height = 8,
            Fill = new SolidColorBrush(dotColor),
            Margin = new Thickness(0, 0, 10, 0),
            VerticalAlignment = VerticalAlignment.Center,
        };

        var nameLabel = new TextBlock
        {
            Text = agent.Name,
            TextWrapping = TextWrapping.Wrap,
            MaxWidth = 240,
            Foreground = new SolidColorBrush(isSelected ? WpfColor.FromRgb(235, 238, 245) : WpfColor.FromRgb(200, 203, 210)),
            FontSize = 13,
            FontWeight = isSelected ? FontWeights.SemiBold : FontWeights.Regular,
            VerticalAlignment = VerticalAlignment.Center,
        };

        UIElement? unreadLabel = null;
        if (hasUnread)
        {
            unreadLabel = new TextBlock
            {
                Text = $"  {agent.UnreadCount}",
                Foreground = new SolidColorBrush(dotColor),
                FontSize = 12,
                FontWeight = FontWeights.Bold,
                VerticalAlignment = VerticalAlignment.Center,
                Margin = new Thickness(8, 0, 0, 0),
            };
        }

        var activeLabel = new TextBlock
        {
            Text = $"  ·  {agent.LastActiveAge}",
            Foreground = new SolidColorBrush(WpfColor.FromRgb(165, 175, 190)),
            FontSize = 11,
            VerticalAlignment = VerticalAlignment.Center,
            Margin = new Thickness(unreadLabel == null ? 8 : 0, 0, 0, 0),
        };

        var row = new StackPanel { Orientation = WpfOrientation.Horizontal };
        row.Children.Add(dot);
        row.Children.Add(nameLabel);
        if (unreadLabel != null) row.Children.Add(unreadLabel);
        row.Children.Add(activeLabel);

        var bg = new SolidColorBrush(isSelected
            ? WpfColor.FromRgb(36, 40, 50)
            : WpfColor.FromRgb(28, 31, 38));
        var border = new Border
        {
            Child = row,
            Background = bg,
            BorderBrush = new SolidColorBrush(isSelected
                ? WpfColor.FromRgb(58, 110, 165)
                : WpfColor.FromRgb(45, 50, 60)),
            BorderThickness = new Thickness(isSelected ? 2 : 1, 0, isSelected ? 2 : 1, isSelected ? 2 : 1),
            CornerRadius = new CornerRadius(4),
            Padding = new Thickness(10, 8, 10, 8),
            Margin = new Thickness(0, 0, 0, 4),
            Cursor = WpfCursor.Hand,
        };

        border.MouseEnter += (_, _) => { if (!isSelected) border.Background = new SolidColorBrush(WpfColor.FromRgb(33, 37, 47)); };
        border.MouseLeave += (_, _) => { if (!isSelected) border.Background = bg; };
        var selectButton = new WpfButton
        {
            Content = border, HorizontalContentAlignment = System.Windows.HorizontalAlignment.Stretch,
            Background = WpfBrushes.Transparent, BorderThickness = new Thickness(0), Padding = new Thickness(0),
            Uid = "agent:" + agent.AgentId,
            ToolTip = "Filter notifications from " + agent.Name + "; activate again to clear the filter.",
        };
        AutomationProperties.SetName(selectButton, (isSelected ? "Clear filter for " : "Filter by ") + agent.Name);
        selectButton.Click += (_, _) =>
        {
            _selectedAgentId = isSelected ? null : agent.AgentId;
            Refresh();
        };

        return selectButton;
    }

    private void RenderEvents(List<StateEvent> events, AgentRegistry registry)
    {
        var savedOffset = _eventList.Parent is ScrollViewer sv ? sv.VerticalOffset : 0.0;
        _eventList.Children.Clear();
        _visibleEventIds.Clear();

        var filtered = _selectedAgentId == null
            ? events
            : events.Where(e => e.AgentId == _selectedAgentId).ToList();

        if (filtered.Count == 0)
        {
            _eventList.Children.Add(new TextBlock
            {
                Text = _selectedAgentId == null ? "Waiting for an Agent notification" : "No events for this agent",
                Foreground = new SolidColorBrush(WpfColor.FromRgb(165, 175, 190)),
                FontSize = 12,
                Margin = new Thickness(0, 16, 0, 0),
                HorizontalAlignment = System.Windows.HorizontalAlignment.Center,
            });
            return;
        }

        foreach (var item in EventPresentation.Order(filtered).Take(20))
        {
            _visibleEventIds.Add(item.Id);
            _eventList.Children.Add(CreateEventCard(item, registry));
        }

        if (filtered.Count > 20)
        {
            _eventList.Children.Add(new TextBlock
            {
                Text = $"...and {filtered.Count - 20} more",
                Foreground = new SolidColorBrush(WpfColor.FromRgb(165, 175, 190)),
                FontSize = 11,
                Margin = new Thickness(0, 4, 0, 0),
            });
        }

        if (_eventList.Parent is ScrollViewer restoreSv && savedOffset > 0)
            restoreSv.ScrollToVerticalOffset(savedOffset);
    }

    private UIElement CreateEventCard(StateEvent item, AgentRegistry registry)
    {
        var agentName = registry.Agents.FirstOrDefault(a => a.AgentId == item.AgentId)?.Name ?? item.AgentName;
        var isUnread = !item.Read;
        var isP0 = item.Priority == "P0";
        var isP1 = item.Priority == "P1";
        var priorityColor = isP0 ? WpfColor.FromRgb(255, 118, 125) : isP1 ? WpfColor.FromRgb(255, 184, 100) : WpfColor.FromRgb(88, 166, 255);

        var eventTypeLabel = EventPresentation.Label(item);

        var cardBg = isUnread
            ? new SolidColorBrush(WpfColor.FromRgb(33, 37, 47))
            : new SolidColorBrush(WpfColor.FromRgb(28, 31, 38));

        var cardBorder = new Border
        {
            Background = cardBg,
            BorderBrush = new SolidColorBrush(isUnread ? priorityColor : WpfColor.FromArgb(0x20, 45, 50, 60)),
            BorderThickness = new Thickness(3, 0, 0, 0),
            CornerRadius = new CornerRadius(4),
            Padding = new Thickness(10, 9, 10, 9),
            Margin = new Thickness(0, 0, 0, 6),
            Cursor = WpfCursor.Arrow,
        };

        cardBorder.MouseEnter += (_, _) => { if (!isUnread) cardBorder.Background = new SolidColorBrush(WpfColor.FromRgb(36, 40, 50)); };
        cardBorder.MouseLeave += (_, _) => { cardBorder.Background = cardBg; };

        var dot = new WpfEllipse
        {
            Width = 8, Height = 8,
            Fill = new SolidColorBrush(priorityColor),
            Margin = new Thickness(0, 0, 6, 0),
        };
        var typeBadge = new TextBlock
        {
            Text = eventTypeLabel,
            TextWrapping = TextWrapping.Wrap,
            MaxWidth = 280,
            Foreground = new SolidColorBrush(priorityColor),
            FontSize = 10, FontWeight = FontWeights.Bold,
            VerticalAlignment = VerticalAlignment.Center,
            Opacity = 1.0,
        };
        var badgeRow = new StackPanel { Orientation = WpfOrientation.Horizontal, Children = { dot, typeBadge } };

        var timeStr = FormatAge(item.Timestamp);
        var nameLabel = new TextBlock
        {
            Text = agentName,
            Foreground = new SolidColorBrush(isUnread ? WpfColor.FromRgb(180, 185, 195) : WpfColor.FromRgb(165, 175, 190)),
            FontSize = 11,
            VerticalAlignment = VerticalAlignment.Center,
            Margin = new Thickness(10, 0, 0, 0),
        };
        var timeLabel = new TextBlock
        {
            Text = timeStr,
            Foreground = new SolidColorBrush(isUnread ? WpfColor.FromRgb(165, 175, 190) : WpfColor.FromRgb(150, 160, 175)),
            FontSize = 10,
            VerticalAlignment = VerticalAlignment.Center,
            Margin = new Thickness(6, 0, 0, 0),
        };
        var readLabel = new TextBlock { Text = isUnread ? "Unread" : "Read",
            Foreground = WpfBrushes.LightGray, Margin = new Thickness(8,0,0,0), FontSize = 10 };
        var topRow = new WrapPanel { Children = { badgeRow, nameLabel, timeLabel, readLabel } };

        var message = new TextBlock
        {
            Text = item.Message,
            Foreground = new SolidColorBrush(isUnread ? WpfColor.FromRgb(200, 203, 210) : WpfColor.FromRgb(180, 185, 195)),
            FontSize = 12,
            TextWrapping = TextWrapping.Wrap,
            Opacity = 1.0,
            Margin = new Thickness(0, 4, 0, 0),
        };

        var details = new TextBlock
        {
            Text = EventPresentation.Details(item), TextWrapping = TextWrapping.Wrap,
            Foreground = new SolidColorBrush(WpfColor.FromRgb(165, 175, 190)),
            FontSize = 11, Margin = new Thickness(0, 6, 0, 0),
        };
        var title = new TextBlock
        {
            Text = item.Title, TextWrapping = TextWrapping.Wrap,
            Foreground = WpfBrushes.White, FontWeight = FontWeights.SemiBold,
            Margin = new Thickness(0, 5, 0, 0),
        };
        var infoPanel = new StackPanel { Children = { topRow, title, message, details } };

        var actionsPanel = new StackPanel { Orientation = WpfOrientation.Horizontal };
        {
            if (registry.Agents.FirstOrDefault(a => a.AgentId == item.AgentId)?.Target is AgentTarget target && target.Pid > 0)
            {
                var jumpBtn = new WpfButton
                {
                    Content = "Focus",
                    Uid = "jump:" + item.Id,
                    Padding = new Thickness(8, 3, 8, 3),
                    FontSize = 10,
                    Margin = new Thickness(0, 0, 6, 0),
                    Background = new SolidColorBrush(WpfColor.FromRgb(58, 110, 165)),
                    Foreground = WpfBrushes.White,
                    BorderThickness = new Thickness(0),
                };
                var aid = item.AgentId;
                AutomationProperties.SetName(jumpBtn, "Return to " + agentName + " session");
                jumpBtn.ToolTip = "Ask Windows to focus the registered Agent window. This does not mark the event read.";
                jumpBtn.Click += async (_, _) => await RunActionAsync(jumpBtn, "Requesting window focus…", () => _commands.JumpAsync(aid));
                actionsPanel.Children.Add(jumpBtn);
            }

            if (registry.Agents.FirstOrDefault(a => a.AgentId == item.AgentId)?.Target is not AgentTarget knownTarget || knownTarget.Pid <= 0)
                actionsPanel.Children.Add(new TextBlock { Text = "Window target unavailable", Foreground = WpfBrushes.LightGray,
                    FontSize = 11, VerticalAlignment = VerticalAlignment.Center, Margin = new Thickness(0,0,10,0) });

            if (isUnread)
            {
            var readBtn = new WpfButton
            {
                Content = "Mark read",
                Uid = "read:" + item.Id,
                Padding = new Thickness(8, 3, 8, 3),
                FontSize = 10,
                Background = new SolidColorBrush(WpfColor.FromRgb(45, 50, 60)),
                Foreground = new SolidColorBrush(WpfColor.FromRgb(180, 185, 195)),
                BorderThickness = new Thickness(0),
            };
            var eventId = item.Id;
            AutomationProperties.SetName(readBtn, "Mark notification read: " + item.Title);
            readBtn.ToolTip = "Mark this notification read; this does not complete or resolve the task.";
            readBtn.Click += async (_, _) => await RunActionAsync(readBtn, "Saving read state…", () => _commands.MarkReadAsync(eventId));
            actionsPanel.Children.Add(readBtn);
            }
        }

        var cardGrid = new Grid();
        cardGrid.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });
        cardGrid.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });
        actionsPanel.Margin = new Thickness(0, 8, 0, 0);
        Grid.SetRow(infoPanel, 0);
        Grid.SetRow(actionsPanel, 1);
        cardGrid.Children.Add(infoPanel);
        cardGrid.Children.Add(actionsPanel);

        cardBorder.Child = cardGrid;
        return cardBorder;
    }

    private static void ConfigureMarkAllButton(WpfButton button)
    {
        button.Content = "Mark all read";
        button.Padding = new Thickness(10, 6, 10, 6);
        button.Background = new SolidColorBrush(WpfColor.FromRgb(58, 110, 165));
        button.Foreground = WpfBrushes.White;
        button.BorderThickness = new Thickness(0);
        button.FontSize = 12;
    }

    private void ShowOutcome(CommandOutcome outcome)
    {
        if (_dataUnavailable) return;
        _status.Text = outcome.Message;
        _status.Foreground = outcome.Ok == true ? WpfBrushes.LightGreen : WpfBrushes.Orange;
        AnnounceStatus();
    }

    private async Task RunActionAsync(WpfButton button, string pending, Func<Task<CommandOutcome>> action)
    {
        if (_pendingCommands > 0 || _dataUnavailable) return;
        _pendingCommands++;
        var label = button.Content;
        button.IsEnabled = false;
        button.Content = "Working…";
        _markAllButton.IsEnabled = false;
        _eventList.IsEnabled = false;
        _status.Text = pending;
        _status.Foreground = WpfBrushes.LightGray;
        AnnounceStatus();
        try { ShowOutcome(await action()); }
        finally
        {
            _pendingCommands--;
            button.Content = label;
            button.IsEnabled = true;
            Refresh();
        }
    }

    private void AnnounceStatus()
    {
        var peer = UIElementAutomationPeer.FromElement(_status) ?? new TextBlockAutomationPeer(_status);
        peer.RaiseAutomationEvent(AutomationEvents.LiveRegionChanged);
    }

    private static FrameworkElement? FindFocusable(DependencyObject root, string uid)
    {
        if (root is FrameworkElement element && element.Uid == uid && element.Focusable) return element;
        for (var index = 0; index < VisualTreeHelper.GetChildrenCount(root); index++)
        {
            var match = FindFocusable(VisualTreeHelper.GetChild(root, index), uid);
            if (match != null) return match;
        }
        return null;
    }

    private static string FormatAge(long timestampMs)
    {
        var elapsed = DateTimeOffset.Now.ToUnixTimeMilliseconds() - timestampMs;
        if (elapsed < 60_000) return "just now";
        if (elapsed < 3_600_000) return $"{elapsed / 60_000}m ago";
        if (elapsed < 86_400_000) return $"{elapsed / 3_600_000}h ago";
        return $"{elapsed / 86_400_000}d ago";
    }

    public IReadOnlyList<string> VisibleEventIds => _visibleEventIds;

    protected override void OnClosing(System.ComponentModel.CancelEventArgs e)
    {
        if (WpfApplication.Current != null && !WpfApplication.Current.Dispatcher.HasShutdownStarted)
        {
            e.Cancel = true;
            Hide();
            return;
        }
        base.OnClosing(e);
    }
}
