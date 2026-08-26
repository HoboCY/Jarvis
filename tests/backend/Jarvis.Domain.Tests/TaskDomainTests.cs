using Jarvis.Domain.Tasks;
using Jarvis.Domain.Notifications;
using Xunit;
using DomainTaskStatus = Jarvis.Domain.Tasks.TaskStatus;

namespace Jarvis.Domain.Tests;

public sealed class TaskDomainTests
{
    [Fact]
    public void RunningCancellationRequiresWorkerConfirmationBeforeCancelled()
    {
        var task = Jarvis.Domain.Tasks.Task.Create(
            Guid.CreateVersion7(),
            Guid.CreateVersion7(),
            Guid.CreateVersion7(),
            "Analyse the report",
            null,
            "[]",
            "[]",
            null,
            WorkerKind.Responses,
            1,
            100);

        task.Assign("fake-worker", 500, 200);
        task.Start(300);

        Assert.True(task.RequestCancellation(400));
        Assert.Equal(DomainTaskStatus.CancellationRequested, task.Status);
        Assert.Throws<InvalidOperationException>(() => task.MarkSucceeded("not allowed", 500));

        Assert.True(task.ConfirmCancellation(600));
        Assert.Equal(DomainTaskStatus.Cancelled, task.Status);
        Assert.Throws<InvalidOperationException>(() => task.Start(700));
    }

    [Fact]
    public void QueuedCancellationIsImmediatelyTerminalAndTerminalTasksCannotRegress()
    {
        var task = Jarvis.Domain.Tasks.Task.Create(
            Guid.CreateVersion7(),
            Guid.CreateVersion7(),
            Guid.CreateVersion7(),
            "Analyse the report",
            null,
            "[]",
            "[]",
            null,
            WorkerKind.Internal,
            1,
            100);

        Assert.True(task.RequestCancellation(200));
        Assert.Equal(DomainTaskStatus.Cancelled, task.Status);
        Assert.False(task.RequestCancellation(300));
        Assert.Throws<InvalidOperationException>(() => task.MarkFailed("late", "late failure", 400));
    }

    [Fact]
    public void TaskStateGraphAllowsEveryDocumentedEdge()
    {
        var queued = CreateTask();
        Assert.Equal(DomainTaskStatus.Queued, queued.Status);
        Assert.True(queued.RequestCancellation(200));
        Assert.Equal(DomainTaskStatus.Cancelled, queued.Status);

        var assigned = CreateTask();
        Assert.True(assigned.Assign("worker", 500, 200));
        Assert.Equal(DomainTaskStatus.Assigned, assigned.Status);
        Assert.True(assigned.Start(300));
        Assert.Equal(DomainTaskStatus.Running, assigned.Status);

        var approval = CreateRunningTask();
        Assert.True(approval.WaitForApproval(400));
        Assert.Equal(DomainTaskStatus.WaitingForApproval, approval.Status);
        Assert.True(approval.Resume(500));
        Assert.Equal(DomainTaskStatus.Running, approval.Status);

        var userInput = CreateRunningTask();
        Assert.True(userInput.WaitForUserInput(400));
        Assert.Equal(DomainTaskStatus.WaitingForUserInput, userInput.Status);
        Assert.True(userInput.Resume(500));
        Assert.Equal(DomainTaskStatus.Running, userInput.Status);

        var succeeded = CreateRunningTask();
        Assert.True(succeeded.MarkProgress("working", 400));
        Assert.True(succeeded.MarkSucceeded("done", 500));
        Assert.Equal(DomainTaskStatus.Succeeded, succeeded.Status);

        var failed = CreateRunningTask();
        Assert.True(failed.MarkFailed("worker_error", "failed", 500));
        Assert.Equal(DomainTaskStatus.Failed, failed.Status);

        var cancelled = CreateRunningTask();
        Assert.True(cancelled.RequestCancellation(400));
        Assert.Equal(DomainTaskStatus.CancellationRequested, cancelled.Status);
        Assert.True(cancelled.ConfirmCancellation(500));
        Assert.Equal(DomainTaskStatus.Cancelled, cancelled.Status);

        var assignedRecovery = CreateAssignedTask();
        Assert.True(assignedRecovery.MarkRecovering(400));
        Assert.Equal(DomainTaskStatus.Recovering, assignedRecovery.Status);
        Assert.True(assignedRecovery.Assign("recovered-worker", 600, 500));
        Assert.Equal(DomainTaskStatus.Assigned, assignedRecovery.Status);

        var runningRecovery = CreateRunningTask();
        Assert.True(runningRecovery.MarkRecovering(400));
        Assert.True(runningRecovery.Assign("recovered-worker", 600, 500));
        Assert.True(runningRecovery.Start(600));
        Assert.Equal(DomainTaskStatus.Running, runningRecovery.Status);

        var approvalRecovery = CreateRunningTask();
        approvalRecovery.WaitForApproval(350);
        Assert.True(approvalRecovery.RenewLease("worker", 700, 400));
        Assert.True(approvalRecovery.MarkRecovering(701));
        Assert.Equal(DomainTaskStatus.Recovering, approvalRecovery.Status);
        Assert.Null(approvalRecovery.LeaseOwner);

        var recoveryFailure = CreateRunningTask();
        recoveryFailure.MarkRecovering(400);
        Assert.True(recoveryFailure.MarkFailed("recovery_error", "recovery failed", 500));
        Assert.Equal(DomainTaskStatus.Failed, recoveryFailure.Status);
    }

    [Fact]
    public void TaskStateGraphRejectsEveryKeyUndocumentedEdge()
    {
        foreach (var status in new[]
        {
            DomainTaskStatus.Assigned,
            DomainTaskStatus.WaitingForApproval,
            DomainTaskStatus.WaitingForUserInput,
            DomainTaskStatus.Recovering
        })
        {
            var task = CreateTaskAt(status);
            Assert.Throws<InvalidOperationException>(() => task.RequestCancellation(900));
            Assert.Equal(status, task.Status);
        }

        var cancellationRequested = CreateTaskAt(DomainTaskStatus.CancellationRequested);
        Assert.False(cancellationRequested.RequestCancellation(900));
        Assert.Equal(DomainTaskStatus.CancellationRequested, cancellationRequested.Status);

        foreach (var status in new[]
        {
            DomainTaskStatus.Succeeded,
            DomainTaskStatus.Failed,
            DomainTaskStatus.Cancelled
        })
        {
            var task = CreateTaskAt(status);
            Assert.False(task.RequestCancellation(900));
            Assert.Equal(status, task.Status);
        }

        foreach (var status in new[]
        {
            DomainTaskStatus.Queued,
            DomainTaskStatus.Assigned,
            DomainTaskStatus.WaitingForApproval,
            DomainTaskStatus.WaitingForUserInput,
            DomainTaskStatus.CancellationRequested,
            DomainTaskStatus.Recovering,
            DomainTaskStatus.Succeeded,
            DomainTaskStatus.Failed,
            DomainTaskStatus.Cancelled
        })
        {
            var task = CreateTaskAt(status);
            Assert.Throws<InvalidOperationException>(() => task.MarkSucceeded("done", 900));
            Assert.Equal(status, task.Status);
        }

        foreach (var status in new[]
        {
            DomainTaskStatus.Queued,
            DomainTaskStatus.Assigned,
            DomainTaskStatus.WaitingForApproval,
            DomainTaskStatus.WaitingForUserInput,
            DomainTaskStatus.CancellationRequested,
            DomainTaskStatus.Succeeded,
            DomainTaskStatus.Failed,
            DomainTaskStatus.Cancelled
        })
        {
            var task = CreateTaskAt(status);
            Assert.Throws<InvalidOperationException>(() => task.MarkFailed("failed", "failed", 900));
            Assert.Equal(status, task.Status);
        }

        foreach (var status in new[]
        {
            DomainTaskStatus.Queued,
            DomainTaskStatus.Assigned,
            DomainTaskStatus.WaitingForApproval,
            DomainTaskStatus.WaitingForUserInput,
            DomainTaskStatus.CancellationRequested,
            DomainTaskStatus.Recovering,
            DomainTaskStatus.Succeeded,
            DomainTaskStatus.Failed,
            DomainTaskStatus.Cancelled
        })
        {
            var task = CreateTaskAt(status);
            Assert.Throws<InvalidOperationException>(() => task.MarkProgress("progress", 900));
            Assert.Equal(status, task.Status);
        }

        foreach (var status in new[]
        {
            DomainTaskStatus.Running,
            DomainTaskStatus.WaitingForApproval,
            DomainTaskStatus.WaitingForUserInput,
            DomainTaskStatus.CancellationRequested,
            DomainTaskStatus.Succeeded,
            DomainTaskStatus.Failed,
            DomainTaskStatus.Cancelled
        })
        {
            var task = CreateTaskAt(status);
            Assert.Throws<InvalidOperationException>(() => task.Assign("worker", 1_000, 900));
            Assert.Equal(status, task.Status);
        }

        var assigned = CreateTaskAt(DomainTaskStatus.Assigned);
        Assert.False(assigned.Assign("worker", 1_000, 900));
        Assert.Equal(DomainTaskStatus.Assigned, assigned.Status);

        foreach (var status in new[]
        {
            DomainTaskStatus.Queued,
            DomainTaskStatus.WaitingForUserInput,
            DomainTaskStatus.CancellationRequested,
            DomainTaskStatus.Succeeded,
            DomainTaskStatus.Failed,
            DomainTaskStatus.Cancelled
        })
        {
            var task = CreateTaskAt(status);
            Assert.Throws<InvalidOperationException>(() => task.Start(900));
            Assert.Equal(status, task.Status);
        }

        var running = CreateTaskAt(DomainTaskStatus.Running);
        Assert.False(running.Start(900));

        foreach (var status in new[]
        {
            DomainTaskStatus.Queued,
            DomainTaskStatus.Assigned,
            DomainTaskStatus.WaitingForUserInput,
            DomainTaskStatus.CancellationRequested,
            DomainTaskStatus.Recovering,
            DomainTaskStatus.Succeeded,
            DomainTaskStatus.Failed,
            DomainTaskStatus.Cancelled
        })
        {
            var task = CreateTaskAt(status);
            Assert.Throws<InvalidOperationException>(() => task.WaitForApproval(900));
            Assert.Equal(status, task.Status);
        }

        foreach (var status in new[]
        {
            DomainTaskStatus.Queued,
            DomainTaskStatus.Assigned,
            DomainTaskStatus.WaitingForApproval,
            DomainTaskStatus.CancellationRequested,
            DomainTaskStatus.Recovering,
            DomainTaskStatus.Succeeded,
            DomainTaskStatus.Failed,
            DomainTaskStatus.Cancelled
        })
        {
            var task = CreateTaskAt(status);
            Assert.Throws<InvalidOperationException>(() => task.WaitForUserInput(900));
            Assert.Equal(status, task.Status);
        }

        foreach (var status in new[]
        {
            DomainTaskStatus.Queued,
            DomainTaskStatus.Assigned,
            DomainTaskStatus.Running,
            DomainTaskStatus.CancellationRequested,
            DomainTaskStatus.Recovering,
            DomainTaskStatus.Succeeded,
            DomainTaskStatus.Failed,
            DomainTaskStatus.Cancelled
        })
        {
            var task = CreateTaskAt(status);
            Assert.Throws<InvalidOperationException>(() => task.Resume(900));
            Assert.Equal(status, task.Status);
        }

        foreach (var status in new[]
        {
            DomainTaskStatus.Queued,
            DomainTaskStatus.WaitingForUserInput,
            DomainTaskStatus.CancellationRequested,
            DomainTaskStatus.Succeeded,
            DomainTaskStatus.Failed,
            DomainTaskStatus.Cancelled
        })
        {
            var task = CreateTaskAt(status);
            Assert.Throws<InvalidOperationException>(() => task.MarkRecovering(900));
            Assert.Equal(status, task.Status);
        }

        var recovering = CreateTaskAt(DomainTaskStatus.Recovering);
        Assert.False(recovering.MarkRecovering(900));
    }

    [Fact]
    public void RunningTaskRenewsOnlyForItsOwner()
    {
        var task = CreateRunningTask();
        var versionBeforeRenewal = task.Version;

        Assert.True(task.RenewLease("worker", 2_000, 400));
        Assert.Equal(DomainTaskStatus.Running, task.Status);
        Assert.Equal("worker", task.LeaseOwner);
        Assert.Equal(2_000, task.LeaseExpiresAtMs);
        Assert.Equal(400, task.HeartbeatAtMs);
        Assert.True(task.Version > versionBeforeRenewal);

        var versionAfterRenewal = task.Version;
        Assert.False(task.RenewLease("another-worker", 3_000, 450));
        Assert.Equal(versionAfterRenewal, task.Version);
        Assert.Equal(2_000, task.LeaseExpiresAtMs);

        Assert.True(task.RequestCancellation(450));
        Assert.False(task.RenewLease("worker", 4_000, 500));
        Assert.Equal(DomainTaskStatus.CancellationRequested, task.Status);
        Assert.Equal(2_000, task.LeaseExpiresAtMs);
    }

    [Fact]
    public void ExpiredLeaseCannotBeRenewedByItsFormerOwner()
    {
        var task = CreateRunningTask();

        Assert.False(task.RenewLease("worker", 2_000, 500));
        Assert.Equal(500, task.LeaseExpiresAtMs);
        Assert.Equal(300, task.HeartbeatAtMs);
    }

    [Fact]
    public void NotificationCanOnlyMoveForward()
    {
        var notification = Notification.Create(
            Guid.CreateVersion7(),
            Guid.CreateVersion7(),
            Guid.CreateVersion7(),
            Guid.CreateVersion7(),
            "task.completed",
            NotificationSeverity.Success,
            "Done",
            "Fake result",
            "task:one:completed",
            100);

        notification.MarkDelivered(200);
        notification.MarkRead(300);
        notification.MarkActioned(400);

        Assert.Equal(NotificationStatus.Actioned, notification.Status);
        Assert.Throws<InvalidOperationException>(() => notification.MarkDelivered(500));
        Assert.Throws<InvalidOperationException>(() => notification.MarkDismissed(600));
    }

    private static Jarvis.Domain.Tasks.Task CreateTask() => Jarvis.Domain.Tasks.Task.Create(
        Guid.CreateVersion7(),
        Guid.CreateVersion7(),
        Guid.CreateVersion7(),
        "Analyse the report",
        null,
        "[]",
        "[]",
        null,
        WorkerKind.Responses,
        1,
        100);

    private static Jarvis.Domain.Tasks.Task CreateAssignedTask()
    {
        var task = CreateTask();
        task.Assign("worker", 500, 200);
        return task;
    }

    private static Jarvis.Domain.Tasks.Task CreateRunningTask()
    {
        var task = CreateAssignedTask();
        task.Start(300);
        return task;
    }

    private static Jarvis.Domain.Tasks.Task CreateTaskAt(DomainTaskStatus status)
    {
        var task = CreateTask();
        switch (status)
        {
            case DomainTaskStatus.Queued:
                return task;
            case DomainTaskStatus.Assigned:
                task.Assign("worker", 500, 200);
                return task;
            case DomainTaskStatus.Running:
                task.Assign("worker", 500, 200);
                task.Start(300);
                return task;
            case DomainTaskStatus.WaitingForApproval:
                task.Assign("worker", 500, 200);
                task.Start(300);
                task.WaitForApproval(400);
                return task;
            case DomainTaskStatus.WaitingForUserInput:
                task.Assign("worker", 500, 200);
                task.Start(300);
                task.WaitForUserInput(400);
                return task;
            case DomainTaskStatus.CancellationRequested:
                task.Assign("worker", 500, 200);
                task.Start(300);
                task.RequestCancellation(400);
                return task;
            case DomainTaskStatus.Recovering:
                task.Assign("worker", 500, 200);
                task.Start(300);
                task.MarkRecovering(400);
                return task;
            case DomainTaskStatus.Succeeded:
                task.Assign("worker", 500, 200);
                task.Start(300);
                task.MarkSucceeded("done", 400);
                return task;
            case DomainTaskStatus.Failed:
                task.Assign("worker", 500, 200);
                task.Start(300);
                task.MarkFailed("failed", "failed", 400);
                return task;
            case DomainTaskStatus.Cancelled:
                task.RequestCancellation(200);
                return task;
            default:
                throw new ArgumentOutOfRangeException(nameof(status), status, null);
        }
    }

}
