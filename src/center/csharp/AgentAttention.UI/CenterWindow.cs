using System.Collections.Generic;
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

    public CenterWindow(StateStore store, CommandRunner commands)
    {
        _store = store;
        _commands = commands;

        Title = "Agent Attention Center";
        Width = 480;
        Height = 560;
        MinWidth = 400;
        MinHeight = 340;
        ResizeMode = ResizeMode.NoResize;
        WindowStartupLocation = WindowStartupLocation.CenterScreen;
        Background = new SolidColorBrush(WpfColor.FromRgb(20, 22, 28));

        var markAllButton = new WpfButton
        {
            Content = "Mark all read",
            Padding = new Thickness(10, 4, 10, 4),
            Background = new SolidColorBrush(WpfColor.FromRgb(58, 110, 165)),
            Foreground = WpfBrushes.White,
            BorderThickness = new Thickness(0),
            FontSize = 11,
        };
        markAllButton.Click += (_, _) => { _commands.MarkAllRead(); Hide(); };

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

        var agentsLabel = new TextBlock
        {
            Text = "AGENTS",
            Foreground = new SolidColorBrush(WpfColor.FromRgb(100, 105, 115)),
            FontSize = 10,
            FontWeight = FontWeights.Bold,
            Margin = new Thickness(14, 8, 0, 4),
        };

        var agentScroll = new ScrollViewer
        {
            VerticalScrollBarVisibility = ScrollBarVisibility.Hidden,
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
            Foreground = new SolidColorBrush(WpfColor.FromRgb(100, 105, 115)),
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

        Grid.SetRow(headerBorder, 0);
        Grid.SetRow(agentsPanel, 1);
        Grid.SetRow(eventsLabel, 2);
        Grid.SetRow(eventScroll, 3);

        root.Children.Add(headerBorder);
        root.Children.Add(agentsPanel);
        root.Children.Add(eventsLabel);
        root.Children.Add(eventScroll);

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
        var snapshot = _store.ReadCenterSnapshot();
        UpdateTitle(snapshot.State.UnreadCount);
        RenderAgents(snapshot.Agents);
        RenderEvents(snapshot.State.Events, snapshot.Registry);
    }

    private void UpdateTitle(int unreadCount)
    {
        Title = unreadCount == 0
            ? "Agent Attention Center"
            : $"Agent Attention Center ({unreadCount})";
        _title.Text = unreadCount == 0
            ? "All caught up"
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
                Foreground = new SolidColorBrush(WpfColor.FromRgb(80, 85, 95)),
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
            ? WpfColor.FromRgb(235, 75, 80)
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
            Foreground = new SolidColorBrush(WpfColor.FromRgb(100, 105, 115)),
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
        border.MouseLeftButtonDown += (_, _) =>
        {
            _selectedAgentId = isSelected ? null : agent.AgentId;
            Refresh();
        };

        return border;
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
                Text = _selectedAgentId == null ? "等待 Agent 发来通知" : "No events for this agent",
                Foreground = new SolidColorBrush(WpfColor.FromRgb(80, 85, 95)),
                FontSize = 12,
                Margin = new Thickness(0, 16, 0, 0),
                HorizontalAlignment = System.Windows.HorizontalAlignment.Center,
            });
            return;
        }

        foreach (var item in filtered.Take(20))
        {
            _visibleEventIds.Add(item.Id);
            _eventList.Children.Add(CreateEventCard(item, registry));
        }

        if (filtered.Count > 20)
        {
            _eventList.Children.Add(new TextBlock
            {
                Text = $"...and {filtered.Count - 20} more",
                Foreground = new SolidColorBrush(WpfColor.FromRgb(80, 85, 95)),
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
        var priorityColor = isP0 ? WpfColor.FromRgb(235, 75, 80) : isP1 ? WpfColor.FromRgb(230, 145, 56) : WpfColor.FromRgb(88, 166, 255);

        var eventTypeLabel = item.Type switch
        {
            "permission_required" or "input_required" => "ACTION",
            "failed" => "FAIL",
            _ => "DONE"
        };

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
            Cursor = WpfCursor.Hand,
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
            Foreground = new SolidColorBrush(priorityColor),
            FontSize = 9, FontWeight = FontWeights.Bold,
            VerticalAlignment = VerticalAlignment.Center,
            Opacity = 0.85,
        };
        var badgeRow = new StackPanel { Orientation = WpfOrientation.Horizontal, Children = { dot, typeBadge } };

        var timeStr = FormatAge(item.Timestamp);
        var nameLabel = new TextBlock
        {
            Text = agentName,
            Foreground = new SolidColorBrush(isUnread ? WpfColor.FromRgb(180, 185, 195) : WpfColor.FromRgb(120, 125, 135)),
            FontSize = 11,
            VerticalAlignment = VerticalAlignment.Center,
            Margin = new Thickness(10, 0, 0, 0),
        };
        var timeLabel = new TextBlock
        {
            Text = timeStr,
            Foreground = new SolidColorBrush(isUnread ? WpfColor.FromRgb(100, 105, 115) : WpfColor.FromRgb(70, 75, 85)),
            FontSize = 10,
            VerticalAlignment = VerticalAlignment.Center,
            Margin = new Thickness(6, 0, 0, 0),
        };
        var topRow = new StackPanel { Orientation = WpfOrientation.Horizontal, Children = { badgeRow, nameLabel, timeLabel } };

        var message = new TextBlock
        {
            Text = item.Message,
            Foreground = new SolidColorBrush(isUnread ? WpfColor.FromRgb(200, 203, 210) : WpfColor.FromRgb(130, 133, 140)),
            FontSize = 12,
            TextWrapping = TextWrapping.Wrap,
            Opacity = isUnread ? 1.0 : 0.7,
            Margin = new Thickness(0, 4, 0, 0),
        };

        var infoPanel = new StackPanel { Children = { topRow, message } };

        var actionsPanel = new StackPanel { Orientation = WpfOrientation.Horizontal };
        if (isUnread)
        {
            if (registry.Agents.FirstOrDefault(a => a.AgentId == item.AgentId)?.Target is AgentTarget target && target.Pid > 0)
            {
                var jumpBtn = new WpfButton
                {
                    Content = "Focus",
                    Padding = new Thickness(8, 3, 8, 3),
                    FontSize = 10,
                    Margin = new Thickness(0, 0, 6, 0),
                    Background = new SolidColorBrush(WpfColor.FromRgb(58, 110, 165)),
                    Foreground = WpfBrushes.White,
                    BorderThickness = new Thickness(0),
                };
                var aid = item.AgentId;
                jumpBtn.Click += (_, _) => _commands.Jump(aid);
                actionsPanel.Children.Add(jumpBtn);
            }

            var readBtn = new WpfButton
            {
                Content = "Mark read",
                Padding = new Thickness(8, 3, 8, 3),
                FontSize = 10,
                Background = new SolidColorBrush(WpfColor.FromRgb(45, 50, 60)),
                Foreground = new SolidColorBrush(WpfColor.FromRgb(180, 185, 195)),
                BorderThickness = new Thickness(0),
            };
            var eventId = item.Id;
            readBtn.Click += (_, _) => _commands.MarkRead(eventId);
            actionsPanel.Children.Add(readBtn);
        }

        var cardGrid = new Grid();
        cardGrid.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
        cardGrid.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        Grid.SetColumn(infoPanel, 0);
        Grid.SetColumn(actionsPanel, 1);
        cardGrid.Children.Add(infoPanel);
        cardGrid.Children.Add(actionsPanel);

        cardBorder.Child = cardGrid;
        return cardBorder;
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
