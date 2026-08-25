using Jarvis.Domain;
using Jarvis.Domain.Conversations;
using Xunit;

namespace Jarvis.Domain.Tests;

public sealed class DomainTests
{
    [Fact]
    public void DomainAssemblyMarkerIsAvailable()
    {
        Assert.NotNull(typeof(DomainAssemblyMarker).Assembly);
    }

    [Fact]
    public void RealtimeSessionHasOneWayLifecycleAndMessageTerminalStateDoesNotRegress()
    {
        var session = RealtimeSession.Create(
            Guid.CreateVersion7(),
            Guid.CreateVersion7(),
            Guid.CreateVersion7(),
            "gpt-realtime",
            "alloy",
            4,
            100);
        session.MarkConnected("external-1", 200);
        session.MarkDisconnected("network", 300);
        Assert.Equal(RealtimeSessionStatus.Disconnected, session.Status);
        Assert.Throws<InvalidOperationException>(() => session.MarkConnected("external-1", 400));

        var message = Message.CreateRealtimeMessage(
            Guid.CreateVersion7(),
            session.ConversationId,
            session.Id,
            MessageRole.Assistant,
            null,
            MessageOutputModality.AudioWithTranscript,
            MessageStatus.Streaming,
            "partial",
            "item-1",
            1,
            200);
        Assert.True(message.ApplyRealtimeUpdate(
            MessageStatus.Interrupted,
            "confirmed",
            null,
            null,
            300));
        Assert.True(message.Version > 1);
        Assert.Throws<InvalidOperationException>(() => message.ApplyRealtimeUpdate(
            MessageStatus.Streaming,
            "rollback",
            null,
            null,
            400));
    }
}
