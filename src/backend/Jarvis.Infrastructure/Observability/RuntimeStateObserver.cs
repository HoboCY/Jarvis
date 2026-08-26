namespace Jarvis.Infrastructure.Observability;

public interface IRuntimeStateObserver
{
    void SetWorker(string name, string state);

    void SetCircuit(string name, string state);

    (IReadOnlyDictionary<string, string> Workers, IReadOnlyDictionary<string, string> Circuits) Snapshot();
}

/// <summary>
/// Process-local runtime state used by diagnostics. Components write their
/// actual lifecycle transitions here; no healthy/default state is synthesized.
/// </summary>
public sealed class RuntimeStateObserver : IRuntimeStateObserver
{
    private readonly object gate = new();
    private readonly Dictionary<string, string> workers = new(StringComparer.Ordinal);
    private readonly Dictionary<string, string> circuits = new(StringComparer.Ordinal);

    public void SetWorker(string name, string state)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(name);
        ArgumentException.ThrowIfNullOrWhiteSpace(state);
        lock (gate)
        {
            workers[name] = state;
        }
    }

    public void SetCircuit(string name, string state)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(name);
        ArgumentException.ThrowIfNullOrWhiteSpace(state);
        lock (gate)
        {
            circuits[name] = state;
        }
    }

    public (IReadOnlyDictionary<string, string> Workers, IReadOnlyDictionary<string, string> Circuits) Snapshot()
    {
        lock (gate)
        {
            return (
                new Dictionary<string, string>(workers, StringComparer.Ordinal),
                new Dictionary<string, string>(circuits, StringComparer.Ordinal));
        }
    }
}
