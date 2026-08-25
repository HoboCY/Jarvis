using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Jarvis.Contracts;

namespace Jarvis.Application.Realtime;

public enum RealtimeOperationStatus
{
    Succeeded,
    Replayed,
    Conflict,
    Invalid,
    NotFound
}

public sealed record RealtimeOperation<T>(
    RealtimeOperationStatus Status,
    T? Value = default,
    string? Detail = null);

public sealed class RealtimeService(
    IRealtimeStore store,
    IRealtimeClientSecretProvider clientSecretProvider,
    ContextAssembler contextAssembler,
    IRealtimeSafetyIdentifierProvider safetyIdentifierProvider,
    TimeProvider timeProvider,
    EphemeralSecretReplayCache replayCache,
    RealtimeClientSecretSingleFlight singleFlight)
{
    private const int MaxIdempotencyKeyLength = 200;
    private const int MaxEventCount = 100;

    public async Task<RealtimeOperation<RealtimeClientSecretResponse>> CreateClientSecretAsync(
        Guid userId,
        string? idempotencyKey,
        RealtimeClientSecretRequest request,
        CancellationToken cancellationToken)
    {
        var keyResult = ValidateIdempotencyKey(idempotencyKey);
        if (keyResult is not null)
        {
            return Invalid<RealtimeClientSecretResponse>(keyResult);
        }

        if (request.ConversationId == Guid.Empty || request.DeviceId == Guid.Empty)
        {
            return Invalid<RealtimeClientSecretResponse>("conversationId and deviceId are required.");
        }

        if (request.PreferredVoice is { Length: > 100 })
        {
            return Invalid<RealtimeClientSecretResponse>("preferredVoice is too long.");
        }

        var normalizedKey = idempotencyKey!.Trim();
        var requestHash = RequestHash.Create(request);
        await using var singleFlightLease = await singleFlight.AcquireAsync(userId, normalizedKey, cancellationToken);
        var nowMs = timeProvider.GetUtcNow().ToUnixTimeMilliseconds();
        if (replayCache.TryGet(userId, normalizedKey, requestHash, nowMs, out var cachedResponse))
        {
            return new(RealtimeOperationStatus.Replayed, cachedResponse);
        }

        var existing = await store.FindClientSecretRequestAsync(userId, normalizedKey, cancellationToken);
        if (existing is not null && !string.Equals(existing.RequestHash, requestHash, StringComparison.Ordinal))
        {
            return Conflict<RealtimeClientSecretResponse>("The Idempotency-Key was already used with a different payload.");
        }

        var bootstrap = await store.GetBootstrapContextAsync(
            userId,
            request,
            contextAssembler,
            cancellationToken);
        if (bootstrap is null)
        {
            return new(RealtimeOperationStatus.NotFound);
        }

        var providerResponse = await clientSecretProvider.CreateAsync(
            new RealtimeClientSecretProviderRequest(
                userId,
                bootstrap.Context,
                safetyIdentifierProvider.Create(userId),
                request.PreferredVoice),
            cancellationToken);

        // The store persists only non-secret metadata. If the request is replayed after a
        // process restart, a fresh short-lived secret is issued for the same durable session.
        var sessionId = existing?.SessionId ?? Guid.CreateVersion7();
        var rotationAtMs = checked(timeProvider.GetUtcNow().ToUnixTimeMilliseconds() + TimeSpan.FromMinutes(50).Ticks / TimeSpan.TicksPerMillisecond);
        var stored = await store.CreateSessionAsync(
            userId,
            normalizedKey,
            requestHash,
            bootstrap,
            providerResponse.Model,
            providerResponse.Voice,
            providerResponse.ExpiresAtMs,
            sessionId,
            existing?.SessionRotationAtMs ?? rotationAtMs,
            cancellationToken);
        if (stored.NotFound)
        {
            return new(RealtimeOperationStatus.NotFound);
        }

        if (stored.Conflict)
        {
            return Conflict<RealtimeClientSecretResponse>(stored.Detail ?? "The realtime session request conflicts with an existing request.");
        }

        var response = new RealtimeClientSecretResponse(
            stored.Response!.Id,
            stored.Response.ConversationId,
            stored.Response.DeviceId,
            bootstrap.Context.AsPrompt(),
            providerResponse.Value,
            providerResponse.ExpiresAtMs,
            stored.Response.Model,
            stored.Response.Voice,
            stored.Response.ContextVersion,
            stored.Response.StartedAtMs + TimeSpan.FromMinutes(50).Ticks / TimeSpan.TicksPerMillisecond);
        replayCache.Set(userId, normalizedKey, requestHash, response);
        return new(existing is null ? RealtimeOperationStatus.Succeeded : RealtimeOperationStatus.Replayed, response);
    }

    public async Task<RealtimeOperation<RealtimeSessionResponse>> MarkConnectedAsync(
        Guid userId,
        Guid sessionId,
        string? idempotencyKey,
        RealtimeSessionConnectedRequest request,
        CancellationToken cancellationToken)
    {
        var validation = ValidateIdempotencyKey(idempotencyKey);
        if (validation is not null
            || string.IsNullOrWhiteSpace(request.ExternalSessionId)
            || request.ExternalSessionId.Trim().Length > 200)
        {
            return Invalid<RealtimeSessionResponse>(validation ?? "externalSessionId is required.");
        }

        var result = await store.MarkConnectedAsync(
            userId,
            sessionId,
            idempotencyKey!.Trim(),
            RequestHash.Create(request),
            request,
            cancellationToken);
        return Map(result);
    }

    public async Task<RealtimeOperation<RealtimeSessionResponse>> MarkEndedAsync(
        Guid userId,
        Guid sessionId,
        string? idempotencyKey,
        RealtimeSessionEndedRequest request,
        CancellationToken cancellationToken)
    {
        var validation = ValidateIdempotencyKey(idempotencyKey);
        if (validation is not null
            || string.IsNullOrWhiteSpace(request.Reason)
            || request.Reason.Trim().Length > 500)
        {
            return Invalid<RealtimeSessionResponse>(validation ?? "reason is required.");
        }

        if (request.Status is not (RealtimeSessionStatusValue.Rotated or RealtimeSessionStatusValue.Disconnected or RealtimeSessionStatusValue.Failed))
        {
            return Invalid<RealtimeSessionResponse>("status must be rotated, disconnected, or failed.");
        }

        var result = await store.MarkEndedAsync(
            userId,
            sessionId,
            idempotencyKey!.Trim(),
            RequestHash.Create(request),
            request,
            cancellationToken);
        return Map(result);
    }

    public async Task<RealtimeOperation<RealtimeEventsIngestResponse>> IngestEventsAsync(
        Guid userId,
        Guid conversationId,
        string? idempotencyKey,
        RealtimeEventsIngestRequest request,
        CancellationToken cancellationToken)
    {
        var validation = ValidateIdempotencyKey(idempotencyKey);
        if (validation is not null)
        {
            return Invalid<RealtimeEventsIngestResponse>(validation);
        }

        if (request.Version != 1)
        {
            return Invalid<RealtimeEventsIngestResponse>("Only normalized realtime event version 1 is supported.");
        }

        if (request.Events is null || request.Events.Count is < 1 or > MaxEventCount)
        {
            return Invalid<RealtimeEventsIngestResponse>("events must contain between 1 and 100 items.");
        }

        if (request.Events.Any(item => string.IsNullOrWhiteSpace(item.EventId)
            || item.EventId.Length > 200
            || item.RealtimeSessionId == Guid.Empty
            || (item.ExternalItemId?.Length ?? 0) > 200
            || (item.ExternalItemId is not null && string.IsNullOrWhiteSpace(item.ExternalItemId))
            || item.Role is not (MessageRoleValue.User or MessageRoleValue.Assistant)
            || string.IsNullOrWhiteSpace(item.Modality)
            || item.Modality is not ("voice" or "typedText" or "audio" or "audioWithTranscript" or "text")
            || item.OccurredAtMs is < 0
            || (item.Text?.Length ?? 0) > 100_000))
        {
            return Invalid<RealtimeEventsIngestResponse>("Each realtime event needs a valid eventId and session identity.");
        }

        var result = await store.IngestEventsAsync(
            userId,
            conversationId,
            idempotencyKey!.Trim(),
            RequestHash.Create(request),
            request,
            cancellationToken);
        if (result.NotFound)
        {
            return new(RealtimeOperationStatus.NotFound);
        }

        return result.Conflict
            ? Conflict<RealtimeEventsIngestResponse>(result.Detail ?? "The realtime events conflict with existing conversation state.")
            : new(RealtimeOperationStatus.Succeeded, result.Response);
    }

    public async Task<RealtimeOperation<DesktopDeviceBootstrapResponse>> GetDesktopDeviceAsync(
        Guid userId,
        string? idempotencyKey,
        CancellationToken cancellationToken)
    {
        var validation = ValidateIdempotencyKey(idempotencyKey);
        if (validation is not null)
        {
            return Invalid<DesktopDeviceBootstrapResponse>(validation);
        }

        var response = await store.GetOrCreateDesktopDeviceAsync(userId, cancellationToken);
        return response is null
            ? new(RealtimeOperationStatus.NotFound)
            : new(RealtimeOperationStatus.Succeeded, response);
    }

    private static RealtimeOperation<RealtimeSessionResponse> Map(RealtimeSessionStoreResult result)
    {
        if (result.NotFound)
        {
            return new(RealtimeOperationStatus.NotFound);
        }

        return result.Conflict
            ? Conflict<RealtimeSessionResponse>(result.Detail ?? "The realtime session operation conflicts with existing state.")
            : new(RealtimeOperationStatus.Succeeded, result.Response);
    }

    private static string? ValidateIdempotencyKey(string? key)
    {
        return string.IsNullOrWhiteSpace(key)
            ? "The Idempotency-Key header is required."
            : key.Trim().Length > MaxIdempotencyKeyLength
                ? "The Idempotency-Key header is too long."
                : null;
    }

    private static RealtimeOperation<T> Invalid<T>(string detail) => new(RealtimeOperationStatus.Invalid, Detail: detail);

    private static RealtimeOperation<T> Conflict<T>(string detail) => new(RealtimeOperationStatus.Conflict, Detail: detail);

    private static class RequestHash
    {
        private static readonly JsonSerializerOptions Options = new(JsonSerializerDefaults.Web);

        public static string Create<T>(T request)
        {
            var json = JsonSerializer.Serialize(request, Options);
            return Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(json)));
        }
    }
}
