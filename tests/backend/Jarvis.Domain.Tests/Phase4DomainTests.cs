using Jarvis.Domain.Approvals;
using Jarvis.Domain.Devices;
using Jarvis.Domain.Tasks;
using Xunit;

namespace Jarvis.Domain.Tests;

public sealed class Phase4DomainTests
{
    [Fact]
    public void ApprovalCanBeDecidedOnlyOnceAndExpiredApprovalCannotBeApproved()
    {
        var approval = Approval.Create(
            Guid.CreateVersion7(),
            Guid.CreateVersion7(),
            Guid.CreateVersion7(),
            Guid.CreateVersion7(),
            "request-1",
            ApprovalKind.FileWrite,
            "write a report",
            "{\"path\":\"/work/report.md\"}",
            ApprovalScope.Once,
            100,
            200);

        Assert.Null(approval.Scope);
        Assert.True(approval.Decide(ApprovalDecision.Approved, ApprovalScope.Once, Guid.NewGuid(), 150));
        Assert.False(approval.Decide(ApprovalDecision.Denied, ApprovalScope.TaskSession, Guid.NewGuid(), 160));
        Assert.Equal(ApprovalStatus.Approved, approval.Status);

        var expired = Approval.Create(
            Guid.CreateVersion7(),
            Guid.CreateVersion7(),
            Guid.CreateVersion7(),
            Guid.CreateVersion7(),
            "request-2",
            ApprovalKind.Command,
            "run command",
            "{}",
            ApprovalScope.TaskSession,
            100,
            200);
        Assert.True(expired.Expire(200));
        Assert.False(expired.Decide(ApprovalDecision.Approved, ApprovalScope.Once, Guid.NewGuid(), 201));
        Assert.Equal(ApprovalStatus.Expired, expired.Status);
    }

    [Fact]
    public void DeviceHeartbeatUpdatesCapabilitiesAndDisabledDeviceCannotAuthenticate()
    {
        var device = Device.Register(
            Guid.CreateVersion7(),
            Guid.CreateVersion7(),
            "Desktop",
            DeviceType.Desktop,
            "macos",
            "[\"readFiles\"]",
            "credential-hash",
            100);

        Assert.True(device.Heartbeat("[\"readFiles\",\"writeFiles\"]", 200));
        Assert.Equal(DeviceStatus.Online, device.Status);
        Assert.Contains("writeFiles", device.CapabilitiesJson, StringComparison.Ordinal);
        Assert.True(device.Disable(300));
        Assert.False(device.CanAuthenticate);
    }

    [Fact]
    public void TaskExecutionTracksCodexThreadTurnAndArtifacts()
    {
        var execution = TaskExecution.Create(
            Guid.CreateVersion7(),
            Guid.CreateVersion7(),
            Guid.CreateVersion7(),
            WorkerKind.Codex,
            100);

        execution.Start(110);
        Assert.True(execution.MarkCodexTurnStarting("thread-1", 111));
        Assert.False(execution.MarkCodexTurnStarting("thread-1", 112));
        Assert.Throws<InvalidOperationException>(() => execution.MarkCodexTurnStarting("thread-2", 112));
        execution.SetCodexTurn("thread-1", "turn-1");
        execution.MarkSucceeded("{\"summary\":\"done\"}", "[{\"path\":\"/work/out.txt\"}]", 120);

        Assert.Equal(TaskExecutionStatus.Succeeded, execution.Status);
        Assert.Equal("thread-1", execution.CodexThreadId);
        Assert.Equal("turn-1", execution.CodexTurnId);
        Assert.Equal(111, execution.CodexTurnStartRequestedAtMs);
        Assert.Contains("out.txt", execution.ArtifactManifestJson, StringComparison.Ordinal);
    }
}
