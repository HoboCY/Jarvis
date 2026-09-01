using Jarvis.Infrastructure.Observability;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Logging.Abstractions;
using System.Text.Json;
using Xunit;

namespace Jarvis.Infrastructure.Tests;

public sealed class Phase6ObservabilityTests
{
    [Fact]
    public void RedactionRemovesSecretsAndSensitivePathsWithoutLeakingTheOriginalValue()
    {
        const string value = "Bearer super-secret sk-live-value ek_ephemeral refresh_token=/tmp/token /Users/test/.ssh/id_rsa";

        var sanitized = SafeLogRedaction.Sanitize(value);

        Assert.DoesNotContain("super-secret", sanitized, StringComparison.Ordinal);
        Assert.DoesNotContain("sk-live-value", sanitized, StringComparison.Ordinal);
        Assert.DoesNotContain("ek_ephemeral", sanitized, StringComparison.Ordinal);
        Assert.DoesNotContain("/Users/test/.ssh/id_rsa", sanitized, StringComparison.Ordinal);
        Assert.Contains("[REDACTED]", sanitized, StringComparison.Ordinal);
    }

    [Fact]
    public void MetricTagsKeepOnlyBoundedDimensionsAndDropEntityIdentifiers()
    {
        var tags = JarvisTelemetry.BoundedTags(
            ("worker.kind", "Responses"),
            ("task.status", "running"),
            ("TaskId", "9f2a"),
            ("ConversationId", "secret-id"));

        Assert.Equal(2, tags.Count);
        Assert.Equal("Responses", tags["worker.kind"]);
        Assert.Equal("running", tags["task.status"]);
        Assert.DoesNotContain("TaskId", tags.Keys);
        Assert.DoesNotContain("ConversationId", tags.Keys);
    }

    [Fact]
    public void JsonFormatterSanitizesNonStringScopeValuesBeforeSerialization()
    {
        var formatter = new SafeJsonConsoleFormatter();
        var state = new[]
        {
            new KeyValuePair<string, object?>("message", "safe")
        };
        var entry = new LogEntry<IEnumerable<KeyValuePair<string, object?>>>(
            LogLevel.Information,
            "test",
            new EventId(1),
            state,
            null,
            static (_, _) => "safe log message");
        var scopes = new SingleScopeProvider(new SecretScope());
        using var writer = new StringWriter();

        formatter.Write(in entry, scopes, writer);

        var output = writer.ToString();
        Assert.DoesNotContain("Bearer scope-secret", output, StringComparison.Ordinal);
        Assert.DoesNotContain("/Users/private/.ssh/id_rsa", output, StringComparison.Ordinal);
        Assert.Contains("[REDACTED]", output, StringComparison.Ordinal);
        Assert.Contains("[REDACTED_PATH]", output, StringComparison.Ordinal);
        using var json = JsonDocument.Parse(output);
        Assert.Equal(JsonValueKind.String, json.RootElement.GetProperty("scopes").GetProperty("scope").ValueKind);
    }

    [Fact]
    public void JsonFormatterRedactsSensitiveFieldNamesAndTheirValuesInStateAndStructuredScopes()
    {
        var formatter = new SafeJsonConsoleFormatter();
        var state = new[]
        {
            new KeyValuePair<string, object?>("ApiKey", "plain-api-key"),
            new KeyValuePair<string, object?>("Authorization", new SecretObject("plain-authorization")),
            new KeyValuePair<string, object?>("safeObject", new SecretObject("Bearer nested-secret /private/absolute/path"))
        };
        var entry = new LogEntry<IEnumerable<KeyValuePair<string, object?>>>(
            LogLevel.Information,
            "test",
            new EventId(2),
            state,
            null,
            static (_, _) => "safe log message");
        var scopes = new SingleScopeProvider(new[]
        {
            new KeyValuePair<string, object?>("RefreshToken", "plain-refresh-token"),
            new KeyValuePair<string, object?>("credential", new SecretObject("plain-credential"))
        });
        using var writer = new StringWriter();

        formatter.Write(in entry, scopes, writer);

        var output = writer.ToString();
        Assert.DoesNotContain("plain-api-key", output, StringComparison.Ordinal);
        Assert.DoesNotContain("plain-authorization", output, StringComparison.Ordinal);
        Assert.DoesNotContain("plain-refresh-token", output, StringComparison.Ordinal);
        Assert.DoesNotContain("plain-credential", output, StringComparison.Ordinal);
        Assert.DoesNotContain("nested-secret", output, StringComparison.Ordinal);
        Assert.DoesNotContain("/private/absolute/path", output, StringComparison.Ordinal);
        Assert.Contains("[REDACTED_FIELD]", output, StringComparison.Ordinal);
        Assert.Contains("[REDACTED]", output, StringComparison.Ordinal);
        Assert.Contains("[REDACTED_PATH]", output, StringComparison.Ordinal);

        using var json = JsonDocument.Parse(output);
        var scopesJson = json.RootElement.GetProperty("scopes");
        Assert.Equal("[REDACTED]", json.RootElement.GetProperty("[REDACTED_FIELD]").GetString());
        Assert.Equal("[REDACTED]", scopesJson.GetProperty("[REDACTED_FIELD]").GetString());
    }

    [Fact]
    public void SimpleFormatterPreservesMultilineSqlAndRedactsMessageAndException()
    {
        const string sql = "SELECT password, secret, credential, \"t\".\"Id\"\nFROM \"Tasks\" AS \"t\"\nWHERE \"t\".\"Id\" = @__id_0";
        const string message = "Executed DbCommand (12ms) [Parameters=[@__id_0='42']]\n" + sql;
        var state = new[]
        {
            new KeyValuePair<string, object?>("commandText", sql),
            new KeyValuePair<string, object?>("ApiKey", "plain structured secret with spaces"),
            new KeyValuePair<string, object?>("{OriginalFormat}", "{commandText}")
        };
        var exception = new InvalidOperationException(
            "Bearer exception-secret sk-live-exception /Users/private/.ssh/id_rsa");
        var entry = new LogEntry<IEnumerable<KeyValuePair<string, object?>>>(
            LogLevel.Error,
            "Microsoft.EntityFrameworkCore.Database.Command",
            new EventId(3),
            state,
            exception,
            static (_, _) => message + " API key plain structured secret with spaces");
        var scopes = new SingleScopeProvider(new[]
        {
            new KeyValuePair<string, object?>("correlation.id", "correlation-123"),
            new KeyValuePair<string, object?>("ApiKey", "plain-scope-secret")
        });
        using var writer = new StringWriter();

        new SafeSimpleConsoleFormatter().Write(in entry, scopes, writer);

        var output = writer.ToString();
        Assert.Contains("Error", output, StringComparison.Ordinal);
        Assert.Contains("Microsoft.EntityFrameworkCore.Database.Command", output, StringComparison.Ordinal);
        Assert.Contains(sql, output, StringComparison.Ordinal);
        Assert.Equal(1, CountOccurrences(output, sql));
        Assert.DoesNotContain("\\u0022", output, StringComparison.Ordinal);
        Assert.DoesNotContain("\\n", output, StringComparison.Ordinal);
        Assert.DoesNotContain("Bearer exception-secret", output, StringComparison.Ordinal);
        Assert.DoesNotContain("sk-live-exception", output, StringComparison.Ordinal);
        Assert.DoesNotContain("/Users/private/.ssh/id_rsa", output, StringComparison.Ordinal);
        Assert.DoesNotContain("plain structured secret with spaces", output, StringComparison.Ordinal);
        Assert.DoesNotContain("plain-scope-secret", output, StringComparison.Ordinal);
        Assert.Contains("[REDACTED]", output, StringComparison.Ordinal);
        Assert.Contains("[REDACTED_PATH]", output, StringComparison.Ordinal);
        Assert.Contains("correlation.id=correlation-123", output, StringComparison.Ordinal);
        Assert.Contains("[REDACTED_FIELD]=[REDACTED]", output, StringComparison.Ordinal);
        Assert.Contains("SELECT password, secret, credential", output, StringComparison.Ordinal);
        Assert.DoesNotContain("commandText", output, StringComparison.Ordinal);

        var timestampText = output[..output.IndexOf(']')].TrimStart('[');
        Assert.True(DateTimeOffset.TryParse(timestampText, out var timestamp));
        Assert.Equal(TimeZoneInfo.Local.GetUtcOffset(timestamp), timestamp.Offset);
    }

    [Theory]
    [InlineData(null, "Json")]
    [InlineData("Json", "Json")]
    [InlineData("jSoN", "Json")]
    [InlineData("Simple", "Simple")]
    [InlineData("sImPlE", "Simple")]
    public void ConsoleFormatSelectionAcceptsJsonAndSimpleCaseInsensitively(
        string? configuredFormat,
        string expectedFormat)
    {
        var values = configuredFormat is null
            ? new Dictionary<string, string?>()
            : new Dictionary<string, string?>
            {
                ["Logging:JarvisConsole:Format"] = configuredFormat
            };
        var configuration = new ConfigurationBuilder()
            .AddInMemoryCollection(values)
            .Build();

        Assert.Equal(expectedFormat, JarvisConsoleLogging.ResolveFormat(configuration));
    }

    [Fact]
    public void ConsoleFormatSelectionRejectsInvalidValuesWithoutEchoingThem()
    {
        const string invalidFormat = "Bearer potential-secret";
        var configuration = new ConfigurationBuilder()
            .AddInMemoryCollection(new Dictionary<string, string?>
            {
                ["Logging:JarvisConsole:Format"] = invalidFormat
            })
            .Build();

        var exception = Assert.Throws<InvalidOperationException>(
            () => JarvisConsoleLogging.ResolveFormat(configuration));

        Assert.Contains("Logging:JarvisConsole:Format", exception.Message, StringComparison.Ordinal);
        Assert.DoesNotContain(invalidFormat, exception.Message, StringComparison.Ordinal);
        Assert.DoesNotContain("potential-secret", exception.Message, StringComparison.Ordinal);
    }

    private static int CountOccurrences(string value, string expected)
    {
        var count = 0;
        var index = 0;
        while ((index = value.IndexOf(expected, index, StringComparison.Ordinal)) >= 0)
        {
            count++;
            index += expected.Length;
        }

        return count;
    }

    private sealed class SecretScope
    {
        public override string ToString() => "Bearer scope-secret /Users/private/.ssh/id_rsa";
    }

    private sealed class SecretObject(string value)
    {
        public override string ToString() => value;
    }

    private sealed class SingleScopeProvider(object scope) : IExternalScopeProvider
    {
        public void ForEachScope<TState>(Action<object, TState> callback, TState state) => callback(scope, state);

        public IDisposable Push(object? state) => throw new NotSupportedException();
    }
}
