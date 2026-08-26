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

    public async Task PublishAsync(OutboxMessage message, CancellationToken cancellationToken)
    {
        var envelope = JsonSerializer.Deserialize<OutboxEventEnvelope>(message.PayloadJson, JsonOptions)
            ?? throw new InvalidOperationException("The outbox payload is invalid.");
        using var document = JsonDocument.Parse(message.PayloadJson);
        var payload = document.RootElement.GetProperty("payload");
        if (payload.TryGetProperty("userId", out var userIdElement)
            && userIdElement.ValueKind == JsonValueKind.String
            && userIdElement.TryGetGuid(out var userId))
        {
            await clientHub.Clients.User(userId.ToString("D")).SendAsync(envelope.Type, envelope, cancellationToken);
        }

        if (payload.TryGetProperty("deviceId", out var deviceIdElement)
            && deviceIdElement.ValueKind == JsonValueKind.String
            && deviceIdElement.TryGetGuid(out var deviceId))
        {
            await deviceHub.Clients.User(deviceId.ToString("D")).SendAsync(envelope.Type, envelope, cancellationToken);
            return;
        }

        if (envelope.Type == "task.available"
            && payload.TryGetProperty("userId", out userIdElement)
            && userIdElement.ValueKind == JsonValueKind.String
            && userIdElement.TryGetGuid(out userId))
        {
            await deviceHub.Clients.Group(DeviceHub.UserGroup(userId)).SendAsync(envelope.Type, envelope, cancellationToken);
        }
    }
}
