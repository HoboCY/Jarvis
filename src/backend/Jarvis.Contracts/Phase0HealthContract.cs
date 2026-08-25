namespace Jarvis.Contracts;

public enum Phase0Status
{
    Ready
}

public sealed record Phase0HealthResponse(Phase0Status Status, string Version);

public static class ContractsAssemblyMarker;
