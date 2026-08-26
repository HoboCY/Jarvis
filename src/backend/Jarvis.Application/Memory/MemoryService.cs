using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Jarvis.Contracts;

namespace Jarvis.Application.Memory;

public sealed class MemoryService(IMemoryStore store)
{
    private const int MaxIdempotencyKeyLength = 200;
    private const int MaxKeyLength = 200;
    private const int MaxValueLength = 20_000;

    public async Task<MemoryOperation<MemoryFactSaveResponse>> SaveAsync(
        Guid userId,
        string? idempotencyKey,
        CreateMemoryFactRequest? request,
        bool allowSensitive,
        CancellationToken cancellationToken)
    {
        var validation = ValidateKey(idempotencyKey);
        if (validation is not null)
        {
            return Invalid<MemoryFactSaveResponse>(validation);
        }

        if (request is null
            || string.IsNullOrWhiteSpace(request.Key)
            || request.Key.Trim().Length > MaxKeyLength)
        {
            return Invalid<MemoryFactSaveResponse>("key is required and must be at most 200 characters.");
        }

        if (string.IsNullOrWhiteSpace(request.Value) || request.Value.Length > MaxValueLength)
        {
            return Invalid<MemoryFactSaveResponse>("value is required and must be at most 20000 characters.");
        }

        if (request.SourceMessageId == Guid.Empty)
        {
            return Invalid<MemoryFactSaveResponse>("sourceMessageId is required.");
        }

        var normalized = request with
        {
            Key = request.Key.Trim(),
            Value = request.Value.Trim()
        };
        return await store.SaveAsync(
            userId,
            idempotencyKey!.Trim(),
            RequestHash.Create(normalized),
            normalized,
            allowSensitive,
            cancellationToken);
    }

    public async Task<MemoryOperation<MemoryFactRetractResponse>> RetractAsync(
        Guid userId,
        Guid memoryId,
        string? idempotencyKey,
        CancellationToken cancellationToken)
    {
        var validation = ValidateKey(idempotencyKey);
        if (validation is not null)
        {
            return Invalid<MemoryFactRetractResponse>(validation);
        }

        if (memoryId == Guid.Empty)
        {
            return Invalid<MemoryFactRetractResponse>("memoryId is required.");
        }

        return await store.RetractAsync(
            userId,
            memoryId,
            idempotencyKey!.Trim(),
            RequestHash.Create(new { memoryId }),
            cancellationToken);
    }

    private static string? ValidateKey(string? key)
    {
        if (string.IsNullOrWhiteSpace(key))
        {
            return "The Idempotency-Key header is required.";
        }

        return key.Trim().Length > MaxIdempotencyKeyLength
            ? "The Idempotency-Key header is too long."
            : null;
    }

    private static MemoryOperation<T> Invalid<T>(string detail) =>
        new(MemoryOperationStatus.Invalid, Detail: detail);

    private static class RequestHash
    {
        private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web);

        public static string Create<T>(T value)
        {
            var json = JsonSerializer.Serialize(value, JsonOptions);
            return Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(json)));
        }
    }
}
