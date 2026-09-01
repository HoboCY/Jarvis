using System.Diagnostics;
using System.Diagnostics.Metrics;
using System.Text.RegularExpressions;

namespace Jarvis.Infrastructure.Observability;

public static partial class SafeLogRedaction
{
    private const string Redacted = "[REDACTED]";
    private const string RedactedField = "[REDACTED_FIELD]";

    public static string Sanitize(string? value, int maxLength = 2_000)
    {
        if (string.IsNullOrEmpty(value))
        {
            return string.Empty;
        }

        var sanitized = BearerToken().Replace(value, $"Bearer {Redacted}");
        sanitized = ApiSecret().Replace(sanitized, Redacted);
        sanitized = SecretAssignment().Replace(sanitized, $"$1{Redacted}");
        sanitized = AbsolutePath().Replace(sanitized, "[REDACTED_PATH]");
        return sanitized.Length <= maxLength ? sanitized : sanitized[..maxLength] + "…";
    }

    public static string SanitizeObject(object? value, int maxLength = 2_000)
    {
        if (value is null)
        {
            return string.Empty;
        }

        return Sanitize(
            value as string
            ?? Convert.ToString(value, System.Globalization.CultureInfo.InvariantCulture),
            maxLength);
    }

    public static string SanitizeMessage<TState>(TState state, string? renderedMessage)
    {
        var message = renderedMessage ?? string.Empty;
        if (state is IEnumerable<KeyValuePair<string, object?>> values)
        {
            foreach (var pair in values)
            {
                if (!IsSensitiveFieldName(pair.Key) || pair.Value is null)
                {
                    continue;
                }

                var sensitiveValue = Convert.ToString(
                    pair.Value,
                    System.Globalization.CultureInfo.InvariantCulture);
                if (!string.IsNullOrEmpty(sensitiveValue))
                {
                    message = message.Replace(sensitiveValue, Redacted, StringComparison.Ordinal);
                }
            }
        }

        return Sanitize(message);
    }

    public static bool IsSensitiveFieldName(string? fieldName)
    {
        if (string.IsNullOrWhiteSpace(fieldName))
        {
            return false;
        }

        var normalized = string.Concat(fieldName.Where(char.IsLetterOrDigit)).ToLowerInvariant();
        return normalized.Contains("apikey", StringComparison.Ordinal)
            || normalized.Contains("accesstoken", StringComparison.Ordinal)
            || normalized.Contains("refreshtoken", StringComparison.Ordinal)
            || normalized.Contains("devicecredential", StringComparison.Ordinal)
            || normalized.Contains("authorization", StringComparison.Ordinal)
            || normalized.Contains("credential", StringComparison.Ordinal)
            || normalized.Contains("secret", StringComparison.Ordinal)
            || normalized.Contains("password", StringComparison.Ordinal)
            || normalized.Contains("bearer", StringComparison.Ordinal);
    }

    public static string SanitizeFieldName(string? fieldName) =>
        IsSensitiveFieldName(fieldName) ? RedactedField : Sanitize(fieldName, 128);

    public static object SanitizeFieldValue(string? fieldName, object? value) =>
        IsSensitiveFieldName(fieldName) ? Redacted : SanitizeObject(value);

    [GeneratedRegex(@"(?i)\bBearer\s+[A-Za-z0-9._~+/=-]+")]
    private static partial Regex BearerToken();

    [GeneratedRegex(@"\b(?:sk|ek|rk|sess)[-_][A-Za-z0-9_-]+", RegexOptions.IgnoreCase)]
    private static partial Regex ApiSecret();

    [GeneratedRegex(@"(?i)(api[_-]?key|access[_-]?token|refresh[_-]?token|device[_-]?credential|secret)\s*[:=]\s*[^\s,;]+")]
    private static partial Regex SecretAssignment();

    [GeneratedRegex(@"(?i)(?:[A-Z]:\\|/(?:Users|home|private|tmp|var/folders)/)[^\s""']+")]
    private static partial Regex AbsolutePath();
}

public static class JarvisTelemetry
{
    public const string ActivitySourceName = "Jarvis";
    public const string MeterName = "Jarvis";
    public const string Version = "1.0.0";

    public static readonly ActivitySource ActivitySource = new(ActivitySourceName, Version);
    public static readonly Meter Meter = new(MeterName, Version);

    public static readonly Counter<long> RealtimeSessionsCreated =
        Meter.CreateCounter<long>("jarvis.realtime.sessions.created");
    public static readonly Counter<long> RealtimeSessionsConnected =
        Meter.CreateCounter<long>("jarvis.realtime.sessions.connected");
    public static readonly Counter<long> RealtimeSessionsDisconnected =
        Meter.CreateCounter<long>("jarvis.realtime.sessions.disconnected");
    public static readonly Counter<long> RealtimeSessionRotations =
        Meter.CreateCounter<long>("jarvis.realtime.sessions.rotated");
    public static readonly Counter<long> RealtimeSpeechInterruptions =
        Meter.CreateCounter<long>("jarvis.realtime.speech.interruptions");
    public static readonly Histogram<double> RealtimeConnectDuration =
        Meter.CreateHistogram<double>("jarvis.realtime.connect.duration", "ms");
    public static readonly Histogram<double> RealtimeTypedMessageDuration =
        Meter.CreateHistogram<double>("jarvis.realtime.typed-message.duration", "ms");
    public static readonly Counter<long> RealtimeTranscriptIngestFailures =
        Meter.CreateCounter<long>("jarvis.realtime.transcript.ingest.failures");

    public static readonly UpDownCounter<long> TaskQueueDepth =
        Meter.CreateUpDownCounter<long>("jarvis.tasks.queue.depth");
    public static readonly Histogram<double> TaskQueueWaitDuration =
        Meter.CreateHistogram<double>("jarvis.tasks.queue.wait", "ms");
    public static readonly Histogram<double> TaskDuration =
        Meter.CreateHistogram<double>("jarvis.tasks.duration", "ms");
    public static readonly Counter<long> TasksCreated =
        Meter.CreateCounter<long>("jarvis.tasks.created");
    public static readonly Counter<long> TasksSucceeded =
        Meter.CreateCounter<long>("jarvis.tasks.succeeded");
    public static readonly Counter<long> TasksFailed =
        Meter.CreateCounter<long>("jarvis.tasks.failed");
    public static readonly Counter<long> TasksCancelled =
        Meter.CreateCounter<long>("jarvis.tasks.cancelled");
    public static readonly Counter<long> TaskRecoveries =
        Meter.CreateCounter<long>("jarvis.tasks.recoveries");
    public static readonly Counter<long> TaskLeaseExpiries =
        Meter.CreateCounter<long>("jarvis.tasks.lease.expiries");
    public static readonly Histogram<double> ApprovalWaitDuration =
        Meter.CreateHistogram<double>("jarvis.tasks.approval.wait", "ms");

    public static readonly Counter<long> CodexProcessStarts =
        Meter.CreateCounter<long>("jarvis.codex.process.starts");
    public static readonly Counter<long> CodexProcessRestarts =
        Meter.CreateCounter<long>("jarvis.codex.process.restarts");
    public static readonly Histogram<double> CodexTurnDuration =
        Meter.CreateHistogram<double>("jarvis.codex.turn.duration", "ms");
    public static readonly Counter<long> CodexApprovals =
        Meter.CreateCounter<long>("jarvis.codex.approvals");
    public static readonly Counter<long> CodexProtocolErrors =
        Meter.CreateCounter<long>("jarvis.codex.protocol.errors");
    public static readonly Counter<long> CodexThreadResumes =
        Meter.CreateCounter<long>("jarvis.codex.thread.resumes");
    public static readonly Counter<long> CodexThreadResumeFailures =
        Meter.CreateCounter<long>("jarvis.codex.thread.resume.failures");
    public static readonly Counter<long> CodexCommandApprovals =
        Meter.CreateCounter<long>("jarvis.codex.approvals.command");
    public static readonly Counter<long> CodexFileChangeApprovals =
        Meter.CreateCounter<long>("jarvis.codex.approvals.file-change");

    public static readonly UpDownCounter<long> OutboxBacklog =
        Meter.CreateUpDownCounter<long>("jarvis.notifications.outbox.backlog");
    public static readonly Histogram<double> NotificationPublishDuration =
        Meter.CreateHistogram<double>("jarvis.notifications.publish.duration", "ms");
    public static readonly Histogram<double> NotificationDeliveryDuration =
        Meter.CreateHistogram<double>("jarvis.notifications.delivery.duration", "ms");
    public static readonly Histogram<double> NotificationReadDuration =
        Meter.CreateHistogram<double>("jarvis.notifications.read.duration", "ms");
    public static readonly Counter<long> NotificationsDelivered =
        Meter.CreateCounter<long>("jarvis.notifications.delivered");
    public static readonly Counter<long> NotificationsRead =
        Meter.CreateCounter<long>("jarvis.notifications.read");
    public static readonly Counter<long> DuplicateNotificationsSuppressed =
        Meter.CreateCounter<long>("jarvis.notifications.duplicates.suppressed");

    private static readonly HashSet<string> AllowedTagNames =
    [
        "worker.kind",
        "task.status",
        "task.result",
        "task.reason",
        "provider",
        "operation",
        "protocol.method",
        "approval.kind",
        "notification.type",
        "session.status",
        "circuit.state",
        "http.method",
        "http.status_class"
    ];

    public static IReadOnlyDictionary<string, object?> BoundedTags(
        params (string Name, object? Value)[] values)
    {
        var result = new Dictionary<string, object?>(StringComparer.Ordinal);
        foreach (var (name, value) in values)
        {
            if (!AllowedTagNames.Contains(name) || value is null)
            {
                continue;
            }

            var text = Convert.ToString(value, System.Globalization.CultureInfo.InvariantCulture);
            if (string.IsNullOrWhiteSpace(text) || text.Length > 64)
            {
                continue;
            }

            result[name] = text;
        }

        return result;
    }

    public static void RecordOutboxEnqueued(string eventType)
    {
        OutboxBacklog.Add(
            1,
            BoundedTags(("operation", "enqueued"), ("notification.type", eventType)).ToArray());
    }

    public static void RecordOutboxPublished()
    {
        OutboxBacklog.Add(
            -1,
            BoundedTags(("operation", "published")).ToArray());
    }

    public static Activity? StartActivity(string name, ActivityKind kind = ActivityKind.Internal) =>
        ActivitySource.StartActivity(name, kind);
}
