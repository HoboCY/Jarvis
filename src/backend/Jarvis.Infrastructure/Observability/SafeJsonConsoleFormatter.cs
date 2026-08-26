using System.Text.Json;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Logging.Console;

namespace Jarvis.Infrastructure.Observability;

public sealed class SafeJsonConsoleFormatter : ConsoleFormatter
{
    public const string FormatterName = "jarvis-json";

    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web);

    public SafeJsonConsoleFormatter() : base(FormatterName)
    {
    }

    public override void Write<TState>(
        in LogEntry<TState> logEntry,
        IExternalScopeProvider? scopeProvider,
        TextWriter textWriter)
    {
        var fields = new Dictionary<string, object?>(StringComparer.Ordinal)
        {
            ["timestamp"] = DateTimeOffset.UtcNow,
            ["level"] = logEntry.LogLevel.ToString(),
            ["category"] = logEntry.Category,
            ["eventId"] = logEntry.EventId.Id,
            ["message"] = SafeLogRedaction.Sanitize(logEntry.Formatter(logEntry.State, logEntry.Exception))
        };

        if (logEntry.Exception is not null)
        {
            fields["exception"] = SafeLogRedaction.Sanitize(logEntry.Exception.ToString());
        }

        if (logEntry.State is IEnumerable<KeyValuePair<string, object?>> state)
        {
            foreach (var pair in state)
            {
                if (string.Equals(pair.Key, "{OriginalFormat}", StringComparison.Ordinal))
                {
                    continue;
                }

                fields[SafeLogRedaction.SanitizeFieldName(pair.Key)] =
                    SafeLogRedaction.SanitizeFieldValue(pair.Key, pair.Value);
            }
        }

        var scopeFields = new Dictionary<string, object?>(StringComparer.Ordinal);
        scopeProvider?.ForEachScope(static (scope, target) =>
        {
            if (scope is IEnumerable<KeyValuePair<string, object?>> values)
            {
                foreach (var pair in values)
                {
                    target[SafeLogRedaction.SanitizeFieldName(pair.Key)] =
                        SafeLogRedaction.SanitizeFieldValue(pair.Key, pair.Value);
                }
            }
            else
            {
                var key = target.Count == 0 ? "scope" : $"scope.{target.Count}";
                target[key] = SafeLogRedaction.SanitizeObject(scope);
            }
        }, scopeFields);

        if (scopeFields.Count > 0)
        {
            fields["scopes"] = scopeFields;
        }

        textWriter.WriteLine(JsonSerializer.Serialize(fields, JsonOptions));
    }
}

public static class JarvisLoggingBuilderExtensions
{
    public static ILoggingBuilder AddJarvisJsonConsole(this ILoggingBuilder builder)
    {
        ArgumentNullException.ThrowIfNull(builder);
        builder.AddConsoleFormatter<SafeJsonConsoleFormatter, ConsoleFormatterOptions>();
        builder.AddConsole(options =>
        {
            options.FormatterName = SafeJsonConsoleFormatter.FormatterName;
        });
        return builder;
    }
}
