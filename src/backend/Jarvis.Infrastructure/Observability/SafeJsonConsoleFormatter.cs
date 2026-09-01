using System.Globalization;
using System.Text.Json;
using Microsoft.Extensions.Configuration;
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
            ["message"] = SafeLogRedaction.SanitizeMessage(
                logEntry.State,
                logEntry.Formatter(logEntry.State, logEntry.Exception))
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

public sealed class SafeSimpleConsoleFormatter : ConsoleFormatter
{
    public const string FormatterName = "jarvis-simple";

    public SafeSimpleConsoleFormatter() : base(FormatterName)
    {
    }

    public override void Write<TState>(
        in LogEntry<TState> logEntry,
        IExternalScopeProvider? scopeProvider,
        TextWriter textWriter)
    {
        var message = SafeLogRedaction.SanitizeMessage(
            logEntry.State,
            logEntry.Formatter(logEntry.State, logEntry.Exception));
        textWriter.Write('[');
        textWriter.Write(DateTimeOffset.Now.ToString("O", CultureInfo.InvariantCulture));
        textWriter.Write(']');
        textWriter.Write(" [");
        textWriter.Write(logEntry.LogLevel.ToString());
        textWriter.Write("] ");
        textWriter.Write(logEntry.Category);
        WriteScopes(scopeProvider, textWriter);
        textWriter.Write(": ");
        textWriter.WriteLine(message);

        if (logEntry.Exception is not null)
        {
            textWriter.Write("Exception: ");
            textWriter.WriteLine(SafeLogRedaction.Sanitize(logEntry.Exception.ToString()));
        }
    }

    private static void WriteScopes(IExternalScopeProvider? scopeProvider, TextWriter textWriter)
    {
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

        if (scopeFields.Count == 0)
        {
            return;
        }

        textWriter.Write(" [");
        var first = true;
        foreach (var (key, value) in scopeFields)
        {
            if (!first)
            {
                textWriter.Write(' ');
            }

            textWriter.Write(key);
            textWriter.Write('=');
            textWriter.Write(value);
            first = false;
        }

        textWriter.Write(']');
    }
}

public static class JarvisConsoleLogging
{
    public const string FormatConfigurationKey = "Logging:JarvisConsole:Format";
    public const string JsonFormat = "Json";
    public const string SimpleFormat = "Simple";

    public static string ResolveFormat(IConfiguration configuration)
    {
        ArgumentNullException.ThrowIfNull(configuration);

        var configuredFormat = configuration[FormatConfigurationKey];
        if (configuredFormat is null)
        {
            return JsonFormat;
        }

        if (string.Equals(configuredFormat, JsonFormat, StringComparison.OrdinalIgnoreCase))
        {
            return JsonFormat;
        }

        if (string.Equals(configuredFormat, SimpleFormat, StringComparison.OrdinalIgnoreCase))
        {
            return SimpleFormat;
        }

        throw new InvalidOperationException(
            $"{FormatConfigurationKey} must be either '{JsonFormat}' or '{SimpleFormat}'.");
    }

    public static ILoggingBuilder AddJarvisConsole(
        this ILoggingBuilder builder,
        IConfiguration configuration)
    {
        ArgumentNullException.ThrowIfNull(builder);

        var format = ResolveFormat(configuration);
        if (string.Equals(format, SimpleFormat, StringComparison.Ordinal))
        {
            builder.AddConsoleFormatter<SafeSimpleConsoleFormatter, ConsoleFormatterOptions>();
            builder.AddConsole(options => options.FormatterName = SafeSimpleConsoleFormatter.FormatterName);
        }
        else
        {
            builder.AddConsoleFormatter<SafeJsonConsoleFormatter, ConsoleFormatterOptions>();
            builder.AddConsole(options => options.FormatterName = SafeJsonConsoleFormatter.FormatterName);
        }

        return builder;
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
