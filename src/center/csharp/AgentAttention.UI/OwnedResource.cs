using System;

namespace AgentAttention.UI;

/// <summary>Owns one disposable resource. Replacing it disposes the previous resource exactly once.</summary>
public sealed class OwnedResource<T> : IDisposable where T : class, IDisposable
{
    public T? Current { get; private set; }
    private bool _disposed;

    public void Replace(T? resource)
    {
        ObjectDisposedException.ThrowIf(_disposed, this);
        if (ReferenceEquals(Current, resource)) return;
        var previous = Current;
        Current = resource;
        previous?.Dispose();
    }

    public void Dispose()
    {
        if (_disposed) return;
        _disposed = true;
        var previous = Current;
        Current = null;
        previous?.Dispose();
    }
}
