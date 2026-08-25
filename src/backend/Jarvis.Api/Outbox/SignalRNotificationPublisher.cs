using System.Text.Json;
using Jarvis.Api.Realtime;
using Jarvis.Application.Outbox;
using Jarvis.Contracts;
using Jarvis.Domain.Outbox;
using Microsoft.AspNetCore.SignalR;

namespace Jarvis.Api.Outbox;

public sealed class SignalRNotificationPublisher(IHubContext<ClientHub> hub) : IOutboxPublisher
{
    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web);

    public async Task PublishAsync(OutboxMessage message, CancellationToken cancellationToken)
    {
        var envelope = JsonSerializer.Deserialize<OutboxEventEnvelope>(message.PayloadJson, JsonOptions)
            ?? throw new InvalidOperationException("The outbox payload is invalid.");
        using var document = JsonDocument.Parse(message.PayloadJson);
        var userId = document.RootElement
            .GetProperty("payload")
            .GetProperty("userId")
            .GetGuid();

        await hub.Clients.User(userId.ToString("D")).SendAsync(
            envelope.Type,
            envelope,
            cancellationToken);
    }
}
