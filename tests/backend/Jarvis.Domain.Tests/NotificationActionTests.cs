using Jarvis.Domain.Notifications;
using Xunit;

namespace Jarvis.Domain.Tests;

public sealed class NotificationActionTests
{
    [Theory]
    [InlineData("task.completed")]
    [InlineData("task.failed")]
    [InlineData("task.cancelled")]
    public void TerminalTaskResultNotificationsOfferOnlyAcknowledge(string type)
    {
        var notification = Create(type);

        Assert.Equal("[\"acknowledge\"]", notification.ActionsJson);
        Assert.Equal(NotificationActionResult.Applied, notification.ApplyAction("acknowledge", 2));
        Assert.Equal(NotificationStatus.Actioned, notification.Status);
    }

    [Fact]
    public void NonTerminalNotificationRejectsAcknowledgeAsNotOffered()
    {
        var notification = Create("task.needsUserInput");

        Assert.Equal(NotificationActionResult.NotOffered, notification.ApplyAction("acknowledge", 2));
        Assert.Equal(NotificationStatus.Pending, notification.Status);
    }

    [Fact]
    public void UnknownActionIsRejectedByTheDomainAllowlist()
    {
        var notification = Create("task.completed");

        Assert.Equal(NotificationActionResult.UnknownAction, notification.ApplyAction("run-command", 2));
        Assert.Equal(NotificationStatus.Pending, notification.Status);
    }

    [Fact]
    public void AcknowledgementCannotChangeAnAlreadyTerminalNotification()
    {
        var notification = Create("task.completed");
        Assert.True(notification.MarkDismissed(2));

        Assert.Equal(NotificationActionResult.InvalidState, notification.ApplyAction("acknowledge", 3));
        Assert.Equal(NotificationStatus.Dismissed, notification.Status);
    }

    private static Notification Create(string type) => Notification.Create(
        Guid.CreateVersion7(),
        Guid.CreateVersion7(),
        Guid.CreateVersion7(),
        Guid.CreateVersion7(),
        type,
        NotificationSeverity.Info,
        "Notification",
        "Notification body",
        $"test:{type}:{Guid.CreateVersion7():N}",
        1);
}
