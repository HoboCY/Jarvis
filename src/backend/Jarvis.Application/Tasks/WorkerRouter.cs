using Jarvis.Domain.Tasks;

namespace Jarvis.Application.Tasks;

public sealed class WorkerRouter
{
    public static readonly IReadOnlySet<string> KnownCapabilities = new HashSet<string>(StringComparer.Ordinal)
    {
        "localFiles",
        "writeFiles",
        "runCommands",
        "networkResearch",
        "deepReasoning",
        "summary",
        "structuredOutput"
    };

    public static WorkerKind Route(IEnumerable<string>? capabilities)
    {
        var normalized = (capabilities ?? Array.Empty<string>())
            .Where(capability => !string.IsNullOrWhiteSpace(capability))
            .Select(capability => capability.Trim())
            .Distinct(StringComparer.Ordinal)
            .ToArray();

        var unknown = normalized.FirstOrDefault(capability => !KnownCapabilities.Contains(capability));
        if (unknown is not null)
        {
            throw new ArgumentException($"Unknown task capability '{unknown}'.", nameof(capabilities));
        }

        if (normalized.Any(capability => capability is "localFiles" or "writeFiles" or "runCommands"))
        {
            return WorkerKind.Codex;
        }

        if (normalized.Any(capability => capability is "networkResearch" or "deepReasoning" or "summary" or "structuredOutput"))
        {
            return WorkerKind.Responses;
        }

        return WorkerKind.Internal;
    }
}
