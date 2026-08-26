using Jarvis.Infrastructure.Observability;
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
