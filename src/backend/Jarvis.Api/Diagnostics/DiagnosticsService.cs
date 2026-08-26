using System.Reflection;
using Jarvis.Application.Identity;
using Jarvis.Domain.Approvals;
using Jarvis.Domain.Devices;
using Jarvis.Domain.Notifications;
using Jarvis.Domain.Tasks;
using Jarvis.Infrastructure.Data;
using Microsoft.EntityFrameworkCore;

namespace Jarvis.Api.Diagnostics;

public sealed record DiagnosticsResponse(
    string Version,
    long ProcessStartedAtMs,
    long UptimeSeconds,
    DiagnosticsDatabase Database,
    DiagnosticsWork Work,
    IReadOnlyDictionary<string, string> Workers,
    IReadOnlyDictionary<string, string> Circuits);

public sealed record DiagnosticsDatabase(bool Available);

public sealed record DiagnosticsWork(
    IReadOnlyDictionary<string, int> TasksByStatus,
    int PendingApprovals,
    int UnreadNotifications,
    int PendingOutbox,
    int OnlineDevices);

public sealed class DiagnosticsService(
    JarvisDbContext db,
    DiagnosticsRegistry registry,
    TimeProvider timeProvider)
{
    private static readonly long ProcessStartedAtMs =
        DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();

    public async Task<DiagnosticsResponse> GetAsync(CancellationToken cancellationToken)
    {
        var available = await db.Database.CanConnectAsync(cancellationToken).ConfigureAwait(false);
        if (!available)
        {
            return Build(false, new Dictionary<string, int>(StringComparer.Ordinal), 0, 0, 0, 0);
        }

        var tasks = await db.Tasks.AsNoTracking()
            .GroupBy(task => task.Status)
            .Select(group => new { group.Key, Count = group.Count() })
            .ToListAsync(cancellationToken)
            .ConfigureAwait(false);
        var taskCounts = tasks.ToDictionary(
            item => item.Key.ToString(),
            item => item.Count,
            StringComparer.Ordinal);
        var pendingApprovals = await db.Approvals.AsNoTracking()
            .CountAsync(approval => approval.Status == ApprovalStatus.Pending, cancellationToken)
            .ConfigureAwait(false);
        var unreadNotifications = await db.Notifications.AsNoTracking()
            .CountAsync(notification => notification.Status == NotificationStatus.Pending
                || notification.Status == NotificationStatus.Delivered, cancellationToken)
            .ConfigureAwait(false);
        var pendingOutbox = await db.OutboxMessages.AsNoTracking()
            .CountAsync(message => message.PublishedAtMs == null, cancellationToken)
            .ConfigureAwait(false);
        var onlineDevices = await db.Devices.AsNoTracking()
            .CountAsync(device => device.Status == DeviceStatus.Online, cancellationToken)
            .ConfigureAwait(false);
        return Build(true, taskCounts, pendingApprovals, unreadNotifications, pendingOutbox, onlineDevices);
    }

    private DiagnosticsResponse Build(
        bool databaseAvailable,
        IReadOnlyDictionary<string, int> taskCounts,
        int pendingApprovals,
        int unreadNotifications,
        int pendingOutbox,
        int onlineDevices)
    {
        var snapshot = registry.Snapshot();
        return new DiagnosticsResponse(
            Assembly.GetEntryAssembly()?.GetName().Version?.ToString() ?? "unknown",
            ProcessStartedAtMs,
            Math.Max(0, (timeProvider.GetUtcNow().ToUnixTimeMilliseconds() - ProcessStartedAtMs) / 1_000),
            new DiagnosticsDatabase(databaseAvailable),
            new DiagnosticsWork(taskCounts, pendingApprovals, unreadNotifications, pendingOutbox, onlineDevices),
            snapshot.Workers,
            snapshot.Circuits);
    }
}
