using System.Diagnostics;

namespace Jarvis.DeviceNode;

/// <summary>
/// Propagates a bounded request correlation identifier to the API without
/// copying authentication or user content headers.
/// </summary>
public sealed class CorrelationIdHttpMessageHandler : DelegatingHandler
{
    private const string HeaderName = "X-Correlation-ID";

    protected override Task<HttpResponseMessage> SendAsync(
        HttpRequestMessage request,
        CancellationToken cancellationToken)
    {
        if (!request.Headers.Contains(HeaderName))
        {
            request.Headers.TryAddWithoutValidation(HeaderName, ResolveCorrelationId());
        }

        return base.SendAsync(request, cancellationToken);
    }

    private static string ResolveCorrelationId()
    {
        var current = Activity.Current?.GetTagItem("correlation.id") as string;
        if (IsValid(current))
        {
            return current!;
        }

        var traceId = Activity.Current?.TraceId.ToString();
        return IsValid(traceId) ? traceId! : Guid.CreateVersion7().ToString("N");
    }

    private static bool IsValid(string? value) =>
        !string.IsNullOrWhiteSpace(value)
        && value.Length <= 128
        && value.All(character => char.IsLetterOrDigit(character) || character is '.' or '_' or ':' or '-');
}
