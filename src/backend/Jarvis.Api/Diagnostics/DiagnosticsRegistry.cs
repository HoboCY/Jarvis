using Jarvis.Infrastructure.Observability;

namespace Jarvis.Api.Diagnostics;

public sealed class DiagnosticsRegistry : IRuntimeStateObserver
{
    private readonly object gate = new();
    private readonly Dictionary<string, string> workers = new(StringComparer.Ordinal);
    private readonly Dictionary<string, string> circuits = new(StringComparer.Ordinal);

    public void SetWorker(string name, string state)
    {
        lock (gate)
        {
            workers[name] = state;
        }
    }

    public void SetCircuit(string name, string state)
    {
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
