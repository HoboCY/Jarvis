using System.Text.Json;
using Jarvis.Api.Realtime;
using Jarvis.Application.Outbox;
using Jarvis.Contracts;
using Jarvis.Domain.Outbox;
using Microsoft.AspNetCore.SignalR;

namespace Jarvis.Api.Outbox;

public sealed class SignalRNotificationPublisher(
    IHubContext<ClientHub> clientHub,
    IHubContext<DeviceHub> deviceHub) : IOutboxPublisher
{
    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web);
    private static readonly HashSet<string> ClientEventTypes = new(StringComparer.Ordinal)
    {
        "conversation.created",
        "message.typed.created",
        "notification.created",
        "notification.updated",
        "task.updated",
        "task.eventAdded",
        "approval.required",
        "approval.resolved",
        "conversation.summaryUpdated",
        "realtime.sessionInvalidated"
    };
    private static readonly HashSet<string> DeviceEventTypes = new(StringComparer.Ordinal)
    {
        "task.available",
        "task.cancellationRequested",
        "approval.resolved",
        "node.configurationChanged"
    };

    public async Task PublishAsync(OutboxMessage message, CancellationToken cancellationToken)
    {
        var envelope = JsonSerializer.Deserialize<OutboxEventEnvelope>(message.PayloadJson, JsonOptions)
            ?? throw new InvalidOperationException("The outbox payload is invalid.");
        using var document = JsonDocument.Parse(message.PayloadJson);
        var payload = document.RootElement.GetProperty("payload");
        var hasUserId = TryGetGuid(payload, "userId", out var userId);
        if (ClientEventTypes.Contains(envelope.Type) && hasUserId)
        {
            await clientHub.Clients.User(userId.ToString("D")).SendAsync(envelope.Type, envelope, cancellationToken);
        }

        if (!DeviceEventTypes.Contains(envelope.Type))
        {
            return;
        }

        if (TryGetGuid(payload, "deviceId", out var deviceId))
        {
            await deviceHub.Clients.User(deviceId.ToString("D")).SendAsync(envelope.Type, envelope, cancellationToken);
            return;
        }

        if (envelope.Type == "task.available" && hasUserId)
        {
            await deviceHub.Clients.Group(DeviceHub.UserGroup(userId)).SendAsync(envelope.Type, envelope, cancellationToken);
        }
    }

    private static bool TryGetGuid(JsonElement payload, string propertyName, out Guid value)
    {
        value = default;
        return payload.TryGetProperty(propertyName, out var element)
            && element.ValueKind == JsonValueKind.String
            && element.TryGetGuid(out value);
    }
}
