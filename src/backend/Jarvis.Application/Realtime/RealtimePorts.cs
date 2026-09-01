using Jarvis.Contracts;
using System.Collections.Concurrent;

namespace Jarvis.Application.Realtime;

public interface IRealtimeClientSecretProvider
{
    Task<RealtimeClientSecretProviderResponse> CreateAsync(
        RealtimeClientSecretProviderRequest request,
        CancellationToken cancellationToken);
}

public interface IRealtimeSafetyIdentifierProvider
{
    string Create(Guid userId);
}

/// <summary>
/// Keeps an idempotent ephemeral response replayable without writing the secret to durable storage.
/// Entries are process-local and naturally disappear on restart or expiry.
/// </summary>
public sealed class EphemeralSecretReplayCache
{
    private readonly ConcurrentDictionary<string, CacheEntry> entries = new(StringComparer.Ordinal);

    public bool TryGet(Guid userId, string key, string requestHash, long nowMs, out RealtimeClientSecretResponse response)
    {
        var cacheKey = CreateKey(userId, key);
        if (entries.TryGetValue(cacheKey, out var entry)
            && entry.Response.ExpiresAt > nowMs)
        {
            if (string.Equals(entry.RequestHash, requestHash, StringComparison.Ordinal))
            {
                response = entry.Response;
                return true;
            }

            // A payload conflict must not evict the original replay. The same key
            // with its original payload still needs to return the original secret.
            response = null!;
            return false;
        }

        entries.TryRemove(cacheKey, out _);
        response = null!;
        return false;
    }

    public void Set(Guid userId, string key, string requestHash, RealtimeClientSecretResponse response)
    {
        entries[CreateKey(userId, key)] = new(requestHash, response);
    }

    private static string CreateKey(Guid userId, string key) => $"{userId:D}:{key}";

    private sealed record CacheEntry(string RequestHash, RealtimeClientSecretResponse Response);
}

/// <summary>
/// Serializes client-secret minting for one user and idempotency key. The entry
/// is removed after the final waiter releases it, so a high-cardinality key set
/// cannot become a permanent in-memory lock table.
/// </summary>
public sealed class RealtimeClientSecretSingleFlight
{
    private readonly ConcurrentDictionary<string, Entry> entries = new(StringComparer.Ordinal);

    public async ValueTask<IAsyncDisposable> AcquireAsync(
        Guid userId,
        string idempotencyKey,
        CancellationToken cancellationToken)
    {
        var key = $"{userId:D}:{idempotencyKey}";
        while (true)
        {
            var entry = entries.GetOrAdd(key, _ => new Entry());
            lock (entry.Gate)
            {
                // A last releaser can remove an entry after GetOrAdd returned it.
                // Never acquire a removed entry: retry against the current map entry
                // so two semaphores can never serve the same key concurrently.
                if (entry.Removed)
                {
                    continue;
                }

                entry.Waiters++;
            }

            try
            {
                await entry.Semaphore.WaitAsync(cancellationToken);
                return new Lease(this, key, entry);
            }
            catch
            {
                ReleaseReference(key, entry, acquired: false);
                throw;
            }
        }
    }

    private void ReleaseReference(string key, Entry entry, bool acquired)
    {
        if (acquired)
        {
            entry.Semaphore.Release();
        }

        var remove = false;
        lock (entry.Gate)
        {
            entry.Waiters--;
            if (entry.Waiters == 0)
            {
                entry.Removed = true;
                remove = true;
            }
        }

        if (remove)
        {
            entries.TryRemove(new KeyValuePair<string, Entry>(key, entry));
        }
    }

    private sealed class Entry
    {
        public SemaphoreSlim Semaphore { get; } = new(1, 1);

        public object Gate { get; } = new();

        public int Waiters { get; set; }

        public bool Removed { get; set; }
    }

    private sealed class Lease(
        RealtimeClientSecretSingleFlight owner,
        string key,
        Entry entry) : IAsyncDisposable
    {
        private int released;

        public ValueTask DisposeAsync()
        {
            if (Interlocked.Exchange(ref released, 1) == 0)
            {
                owner.ReleaseReference(key, entry, acquired: true);
            }

            return ValueTask.CompletedTask;
        }
    }
}

public sealed record RealtimeClientSecretProviderRequest(
    Guid UserId,
    ContextPackage Context,
    string SafetyIdentifier,
    string? PreferredVoice);

public sealed record RealtimeClientSecretProviderResponse(
    string Value,
    long ExpiresAtMs,
    string ExternalSessionId,
    string Model,
    string Voice,
    string WebRtcUrl);

public sealed record ContextPackage(
    long ContextVersion,
    string Instructions,
    string UserPreferences,
    string Summary,
    IReadOnlyList<ContextMessage> RecentMessages,
    string TasksAndResults,
    string MemoryFacts)
{
    public string AsPrompt()
    {
        return string.Join(
            "\n\n",
            Instructions,
            Section("User preferences", UserPreferences),
            Section("Conversation summary", Summary),
            Section(
                "Recent conversation",
                string.Join("\n", RecentMessages.Select(message => $"{message.Role}: {message.Text}"))),
            Section("Tasks and results", TasksAndResults),
            Section("Memory facts", MemoryFacts));
    }

    private static string Section(string title, string content)
    {
        return string.IsNullOrWhiteSpace(content) ? $"[{title}: none]" : $"[{title}]\n{content}";
    }
}

public sealed record ContextMessage(string Role, string Text);

public sealed record ContextAssemblyInput(
    long ContextVersion,
    string FixedInstructions,
    string UserPreferences,
    string Summary,
    IReadOnlyList<ContextMessage> RecentMessages,
    string TasksAndResults,
    string MemoryFacts);

public sealed class ContextAssembler
{
    public const int UserPreferencesBudget = 1_000;
    public const int SummaryBudget = 2_000;
    public const int RecentMessagesBudget = 6_000;
    public const int TasksAndResultsBudget = 1_500;
    public const int MemoryFactsBudget = 1_500;

    public const string FixedInstructions = """
        You are Jarvis.
        Jarvis is your sole product identity and public name.
        Always identify yourself as Jarvis when asked who you are or what your name is.
        Never identify yourself as ChatGPT or use ChatGPT as your name.
        If asked whether you are ChatGPT or what technology powers you, explain that you are Jarvis, a personal assistant powered by the configured OpenAI Realtime model, and that ChatGPT is a separate product.
        On the first greeting, introduce yourself as: "我是 Jarvis，你的个人助手。"
        You are a Chinese-first personal assistant.
        Be concise and natural in voice. Distinguish answering a question from executing an operation.
        Never claim to have read files, run commands, or accessed an external system unless a backend tool reports success.
        Long-running or multi-step work must use the approved backend task tools and must wait for application approval for high-risk actions.
        Do not expose secrets, raw audio, or sensitive personal data. Do not invent calendar, reminder, or unavailable capabilities.
        Typed input requests text-only output unless the application explicitly asks for speech.
        """;

    [System.Diagnostics.CodeAnalysis.SuppressMessage("Performance", "CA1822", Justification = "The assembler is registered as an application boundary for dependency injection.")]
    public ContextPackage Assemble(ContextAssemblyInput input)
    {
        ArgumentNullException.ThrowIfNull(input);
        ArgumentOutOfRangeException.ThrowIfNegative(input.ContextVersion);
        if (string.IsNullOrWhiteSpace(input.FixedInstructions))
        {
            throw new ArgumentException("Fixed instructions are required.", nameof(input));
        }

        // The fixed safety/personality instructions intentionally never go through a budget.
        var recent = new List<ContextMessage>();
        var remainingRecentTokens = RecentMessagesBudget;
        foreach (var message in input.RecentMessages.Reverse())
        {
            if (remainingRecentTokens <= 0)
            {
                break;
            }

            var maxCharacters = remainingRecentTokens * 4;
            var text = message.Text.Length <= maxCharacters
                ? message.Text
                : message.Text[..maxCharacters];
            if (text.Length == 0)
            {
                continue;
            }

            recent.Add(new ContextMessage(message.Role, text));
            remainingRecentTokens -= EstimateTokens(text);
        }
        recent.Reverse();

        return new ContextPackage(
            input.ContextVersion,
            input.FixedInstructions,
            TakeBudget(input.UserPreferences, UserPreferencesBudget),
            TakeBudget(input.Summary, SummaryBudget),
            recent,
            TakeBudget(input.TasksAndResults, TasksAndResultsBudget),
            TakeBudget(input.MemoryFacts, MemoryFactsBudget));
    }

    public static int EstimateTokens(string? value)
    {
        return string.IsNullOrEmpty(value) ? 0 : (value.Length + 3) / 4;
    }

    private static string TakeBudget(string? value, int budget)
    {
        if (string.IsNullOrEmpty(value))
        {
            return string.Empty;
        }

        var maxCharacters = checked(budget * 4);
        return value.Length <= maxCharacters ? value : value[..maxCharacters];
    }
}

public static class SafetyIdentifier
{
    public static string Create(Guid userId, string salt)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(salt);
        var bytes = System.Security.Cryptography.SHA256.HashData(
            System.Text.Encoding.UTF8.GetBytes($"{salt}:{userId:D}"));
        return Convert.ToHexString(bytes).ToLowerInvariant();
    }
}

public sealed record RealtimeBootstrapContext(
    Guid UserId,
    Guid ConversationId,
    Guid DeviceId,
    ContextPackage Context,
    string? PreferredVoice);

public sealed record StoredClientSecretRequest(
    string RequestHash,
    Guid SessionId,
    Guid ConversationId,
    Guid DeviceId,
    string Model,
    string Voice,
    long ContextVersion,
    long SessionRotationAtMs);

public sealed record RealtimeSessionStoreResult(
    RealtimeSessionResponse? Response,
    bool Conflict = false,
    bool NotFound = false,
    string? Detail = null);

public sealed record RealtimeEventStoreResult(
    RealtimeEventsIngestResponse? Response,
    bool Conflict = false,
    bool NotFound = false,
    string? Detail = null);

public interface IRealtimeStore
{
    Task<RealtimeBootstrapContext?> GetBootstrapContextAsync(
        Guid userId,
        RealtimeClientSecretRequest request,
        ContextAssembler assembler,
        CancellationToken cancellationToken);

    Task<StoredClientSecretRequest?> FindClientSecretRequestAsync(
        Guid userId,
        string idempotencyKey,
        CancellationToken cancellationToken);

    Task<RealtimeSessionStoreResult> CreateSessionAsync(
        Guid userId,
        string idempotencyKey,
        string requestHash,
        RealtimeBootstrapContext bootstrap,
        string model,
        string voice,
        long expiresAtMs,
        Guid sessionId,
        long sessionRotationAtMs,
        CancellationToken cancellationToken);

    Task<RealtimeSessionStoreResult> GetSessionAsync(
        Guid userId,
        Guid sessionId,
        CancellationToken cancellationToken);

    Task<RealtimeSessionStoreResult> MarkConnectedAsync(
        Guid userId,
        Guid sessionId,
        string idempotencyKey,
        string requestHash,
        RealtimeSessionConnectedRequest request,
        CancellationToken cancellationToken);

    Task<RealtimeSessionStoreResult> MarkEndedAsync(
        Guid userId,
        Guid sessionId,
        string idempotencyKey,
        string requestHash,
        RealtimeSessionEndedRequest request,
        CancellationToken cancellationToken);

    Task<RealtimeEventStoreResult> IngestEventsAsync(
        Guid userId,
        Guid conversationId,
        string idempotencyKey,
        string requestHash,
        RealtimeEventsIngestRequest request,
        CancellationToken cancellationToken);

    Task<DesktopDeviceBootstrapResponse?> GetOrCreateDesktopDeviceAsync(
        Guid userId,
        CancellationToken cancellationToken);
}
