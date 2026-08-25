using Jarvis.Domain.Outbox;

namespace Jarvis.Application.Outbox;

public interface IOutboxPublisher
{
    Task PublishAsync(OutboxMessage message, CancellationToken cancellationToken);
}
