using Jarvis.DeviceNode;
using Jarvis.DeviceNode.Codex;
using Jarvis.Contracts;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Options;
using System.Collections.Concurrent;
using System.Text.Json;
using Xunit;

namespace Jarvis.DeviceNode.Tests;

public sealed class DeviceNodeTests
{
    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web);

    [Fact]
    public void DeviceNodeAssemblyMarkerIsAvailable()
    {
        Assert.NotNull(typeof(DeviceNodeAssemblyMarker).Assembly);
    }

    [Fact]
    public void CodexProtocolMethodsArePinnedToThe146Contract()
    {
        Assert.Equal("initialize", CodexProtocolMethods.Initialize);
        Assert.Equal("initialized", CodexProtocolMethods.Initialized);
        Assert.Equal("thread/start", CodexProtocolMethods.ThreadStart);
        Assert.Equal("thread/resume", CodexProtocolMethods.ThreadResume);
        Assert.Equal("turn/start", CodexProtocolMethods.TurnStart);
        Assert.Equal("turn/interrupt", CodexProtocolMethods.TurnInterrupt);
        Assert.Contains("item/commandExecution/requestApproval", CodexProtocolMethods.ServerApprovalRequests);
        Assert.Contains("item/fileChange/requestApproval", CodexProtocolMethods.ServerApprovalRequests);
        Assert.Contains("item/permissions/requestApproval", CodexProtocolMethods.ServerApprovalRequests);
        Assert.Equal("process/exited", CodexProtocolMethods.ProcessExited);
    }

    [Fact]
    public void ApprovalResponsesUseThePinned146ShapesAndNeverGrantDeniedPermissions()
    {
        var root = Path.Combine(Path.GetTempPath(), $"jarvis-approval-root-{Guid.NewGuid():N}");
        Directory.CreateDirectory(root);
        var allowed = Path.Combine(root, "report.md");
        var outside = Path.Combine(Path.GetTempPath(), $"jarvis-outside-{Guid.NewGuid():N}.md");
        var policy = Jarvis.Application.Devices.CapabilityPolicy.Create(
            new Jarvis.Application.Devices.CapabilityEnvelope(ReadFiles: true, WriteFiles: true, RunCommands: true, Network: false, AllowedRoots: [root]));
        try
        {
            using var request = System.Text.Json.JsonDocument.Parse($"{{\"permissions\":{{\"fileSystem\":{{\"entries\":[{{\"access\":\"write\",\"path\":{{\"type\":\"path\",\"path\":\"{allowed.Replace("\\", "\\\\")}\"}}}},{{\"access\":\"write\",\"path\":{{\"type\":\"path\",\"path\":\"{outside.Replace("\\", "\\\\")}\"}}}}]}},\"network\":{{\"enabled\":true}}}}}}");
            var approved = CodexApprovalResponseFactory.Create(
                "item/permissions/requestApproval",
                ApprovalDecisionValue.Approve,
                ApprovalScopeValue.Once,
                request.RootElement,
                policy);
            var approvedJson = System.Text.Json.JsonSerializer.Serialize(approved, JsonOptions);
            using var approvedDocument = System.Text.Json.JsonDocument.Parse(approvedJson);
            var permissionResponse = approvedDocument.RootElement;
            Assert.Equal("turn", permissionResponse.GetProperty("scope").GetString());
            Assert.False(permissionResponse.GetProperty("permissions").GetProperty("network").GetProperty("enabled").GetBoolean());
            var entries = permissionResponse.GetProperty("permissions").GetProperty("fileSystem").GetProperty("entries");
            Assert.Single(entries.EnumerateArray());
            Assert.Equal(allowed, entries[0].GetProperty("path").GetProperty("path").GetString());

            var denied = CodexApprovalResponseFactory.Create(
                "item/permissions/requestApproval",
                ApprovalDecisionValue.Deny,
                ApprovalScopeValue.Once,
                request.RootElement,
                policy);
            using var deniedDocument = System.Text.Json.JsonDocument.Parse(
                System.Text.Json.JsonSerializer.Serialize(denied, JsonOptions));
            Assert.Empty(deniedDocument.RootElement.GetProperty("permissions").GetProperty("fileSystem").GetProperty("entries").EnumerateArray());
            Assert.False(deniedDocument.RootElement.GetProperty("permissions").GetProperty("network").GetProperty("enabled").GetBoolean());

            var command = (CommandExecutionApprovalResponse)CodexApprovalResponseFactory.Create(
                "item/commandExecution/requestApproval", ApprovalDecisionValue.Approve, ApprovalScopeValue.TaskSession, policy: policy);
            var file = (FileChangeApprovalResponse)CodexApprovalResponseFactory.Create(
                "item/fileChange/requestApproval", ApprovalDecisionValue.Approve, ApprovalScopeValue.TaskSession, policy: policy);
            var deniedFile = (FileChangeApprovalResponse)CodexApprovalResponseFactory.Create(
                "item/fileChange/requestApproval", ApprovalDecisionValue.Deny, ApprovalScopeValue.Once, policy: policy);
            Assert.Equal("acceptForSession", command.Decision);
            Assert.Equal("acceptForSession", file.Decision);
            Assert.Equal("cancel", deniedFile.Decision);
        }
        finally
        {
            Directory.Delete(root, recursive: true);
            if (File.Exists(outside))
            {
                File.Delete(outside);
            }
        }
    }

    [Fact]
    public async System.Threading.Tasks.Task ApprovalPollingReturnsTheBoundDecisionAndDoesNotTrustUnrelatedStatus()
    {
        var controlPlane = new RecordingControlPlane
        {
            ApprovalStatuses = new Queue<ApprovalStatusValue>([
                ApprovalStatusValue.Pending,
                ApprovalStatusValue.Approved])
        };
        var options = Options.Create(new DeviceNodeOptions { PollingIntervalMs = 25 });
        var waiter = new PollingApprovalDecisionWaiter(controlPlane, options, TimeProvider.System);

        var decision = await waiter.WaitAsync(Guid.NewGuid(), Guid.NewGuid(), new CancellationTokenSource(TimeSpan.FromSeconds(2)).Token);

        Assert.Equal(ApprovalDecisionValue.Approve, decision?.Decision);
        Assert.Equal(ApprovalScopeValue.Once, decision?.Scope);
        Assert.Equal(2, controlPlane.ApprovalPollCount);
    }

    [Fact]
    public async System.Threading.Tasks.Task BootstrapLoadsTheDeviceIdentityFromSecureStorageWithoutRegisteringAgain()
    {
        var identity = new DeviceNodeIdentity(Guid.NewGuid(), "stored-device-credential");
        var store = new RecordingIdentityStore(identity);
        var registration = new RecordingRegistrationClient();
        var options = new DeviceNodeOptions();
        var bootstrapper = new DeviceNodeBootstrapper(Options.Create(options), store, registration);

        await bootstrapper.InitializeAsync();

        Assert.Equal(identity.DeviceId, options.DeviceId);
        Assert.Equal(identity.DeviceCredential, options.DeviceCredential);
        Assert.Equal(0, registration.Calls);
    }

    [Fact]
    public async System.Threading.Tasks.Task BootstrapRegistersOnceAndPersistsTheRawCredentialOutsideConfiguration()
    {
        var registered = new DeviceRegistrationResponse(
            Guid.NewGuid(),
            Guid.NewGuid(),
            "Jarvis Node",
            DeviceTypeValue.Desktop,
            "macos",
            ["localFiles"],
            DeviceStatusValue.Offline,
            "one-time-device-credential");
        var store = new RecordingIdentityStore(null);
        var registration = new RecordingRegistrationClient { Response = registered };
        var options = new DeviceNodeOptions
        {
            BootstrapBearer = new string('b', 64),
            Name = "Jarvis Node",
            Platform = "macos",
            Capabilities = new CapabilityEnvelopeOptions
            {
                ReadFiles = true,
                AllowedRoots = [Path.GetTempPath()]
            }
        };
        var bootstrapper = new DeviceNodeBootstrapper(Options.Create(options), store, registration);

        await bootstrapper.InitializeAsync();

        Assert.Equal(1, registration.Calls);
        Assert.Equal(registered.DeviceId, store.Saved?.DeviceId);
        Assert.Equal(registered.DeviceCredential, store.Saved?.DeviceCredential);
        Assert.Equal(registered.DeviceCredential, options.DeviceCredential);
        Assert.Equal(string.Empty, options.BootstrapBearer);
    }

    [Fact]
    public async System.Threading.Tasks.Task FakeJsonlProcessCompletesInitializeThreadTurnAndInterrupt()
    {
        var script = Path.Combine(Path.GetTempPath(), $"jarvis-fake-codex-{Guid.NewGuid():N}.sh");
        await File.WriteAllTextAsync(script, "#!/bin/sh\nwhile IFS= read -r line; do\n  if echo \"$line\" | grep -q '\"method\":\"initialize\"'; then echo '{\"id\":1,\"result\":{}}'; fi\n  if echo \"$line\" | grep -q '\"method\":\"thread/start\"'; then echo '{\"id\":2,\"result\":{\"thread\":{\"id\":\"thread-fake\"}}}'; fi\n  if echo \"$line\" | grep -q '\"method\":\"turn/start\"'; then echo '{\"id\":3,\"result\":{\"turn\":{\"id\":\"turn-fake\"}}}'; echo '{\"method\":\"item/agentMessage/delta\",\"params\":{\"delta\":\"hello\"}}'; echo '{\"id\":99,\"method\":\"item/fileChange/requestApproval\",\"params\":{\"itemId\":\"item-1\",\"threadId\":\"thread-fake\",\"turnId\":\"turn-fake\",\"startedAtMs\":1}}'; fi\n  if echo \"$line\" | grep -q '\"method\":\"turn/interrupt\"'; then echo '{\"id\":4,\"result\":{}}'; fi\ndone\n");
        if (!OperatingSystem.IsWindows())
        {
            File.SetUnixFileMode(script, UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute);
        }

        try
        {
            await using var client = new CodexAppServerClient(new CodexRuntimeOptions(script, []));
            await client.InitializeAsync();
            var thread = await client.StartThreadAsync(
                Jarvis.Application.Devices.CapabilityPolicy.Create(new Jarvis.Application.Devices.CapabilityEnvelope()),
                null);
            var turn = await client.StartTurnAsync(thread.ThreadId, "hello");
            Assert.Equal("thread-fake", thread.ThreadId);
            Assert.Equal("turn-fake", turn.TurnId);

            using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(2));
            await using var events = client.ReadEventsAsync(timeout.Token).GetAsyncEnumerator(timeout.Token);
            var sawProgress = false;
            var sawApproval = false;
            while (await events.MoveNextAsync())
            {
                sawProgress |= events.Current.Method == "item/agentMessage/delta";
                sawApproval |= events.Current.Method == "item/fileChange/requestApproval" && events.Current.IsRequest;
                if (sawProgress && sawApproval)
                {
                    break;
                }
            }

            Assert.True(sawProgress);
            Assert.True(sawApproval);
            await client.InterruptTurnAsync(thread.ThreadId, turn.TurnId);
        }
        finally
        {
            File.Delete(script);
        }
    }

    [Fact]
    public async System.Threading.Tasks.Task SupervisorMarksRecoveryAndResumesTheExistingThreadWithBoundedRestarts()
    {
        var runtimes = new Queue<ICodexRuntime>([
            new FailingRuntime("thread-1"),
            new SuccessfulRuntime("thread-1")
        ]);
        var states = new List<CodexSupervisorState>();
        var supervisor = new CodexProcessSupervisor(
            _ => System.Threading.Tasks.Task.FromResult(runtimes.Dequeue()),
            new CodexSupervisorOptions(MaxRestartAttempts: 1, RestartDelay: TimeSpan.FromMilliseconds(1)));

        var result = await supervisor.RunAsync(
            policy: Jarvis.Application.Devices.CapabilityPolicy.Create(new Jarvis.Application.Devices.CapabilityEnvelope()),
            cwd: null,
            existingThreadId: null,
            execute: async (runtime, thread, token) =>
            {
                states.Add(new CodexSupervisorState(CodexSupervisorStatus.Running, 0, thread, null));
                await runtime.StartTurnAsync(thread, "hello", token);
                return "done";
            },
            onState: states.Add);

        Assert.Equal("done", result);
        Assert.Contains(states, state => state.Status == CodexSupervisorStatus.Recovering && state.RestartAttempt == 1);
        Assert.Contains(states, state => state.Status == CodexSupervisorStatus.Succeeded);
        Assert.Equal("thread-1", states.Last(state => state.Status == CodexSupervisorStatus.Succeeded).ThreadId);
    }

    [Fact]
    public async System.Threading.Tasks.Task ProcessEofFailsPendingRequestsAndSurfacesAnExitEvent()
    {
        var script = Path.Combine(Path.GetTempPath(), $"jarvis-fake-codex-eof-{Guid.NewGuid():N}.sh");
        await File.WriteAllTextAsync(script, "#!/bin/sh\nIFS= read -r line\nif echo \"$line\" | grep -q '\"method\":\"initialize\"'; then echo '{\"id\":1,\"result\":{}}'; fi\necho 'Bearer secret-token /Users/example/.ssh/id_rsa' >&2\nIFS= read -r line\n");
        if (!OperatingSystem.IsWindows())
        {
            File.SetUnixFileMode(script, UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute);
        }

        try
        {
            await using var client = new CodexAppServerClient(new CodexRuntimeOptions(script, []));
            await client.InitializeAsync();
            using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(2));
            var exit = await client.ReadEventsAsync(timeout.Token)
                .FirstAsync(item => item.Method == CodexProtocolMethods.ProcessExited, timeout.Token);
            Assert.True(exit.Method == CodexProtocolMethods.ProcessExited);
            await client.ProcessExit.WaitAsync(timeout.Token);
            Assert.Contains("content was redacted", client.StderrSummary, StringComparison.Ordinal);
            Assert.DoesNotContain("secret-token", client.StderrSummary, StringComparison.Ordinal);
            Assert.DoesNotContain(".ssh", client.StderrSummary, StringComparison.Ordinal);
            await Assert.ThrowsAnyAsync<Exception>(() => client.StartThreadAsync(
                Jarvis.Application.Devices.CapabilityPolicy.Create(new Jarvis.Application.Devices.CapabilityEnvelope()),
                null));
        }
        finally
        {
            File.Delete(script);
        }
    }

    [Fact]
    public async System.Threading.Tasks.Task FakeJsonlApprovalBridgeContinuesTheSameTurnAndPersistsItsResult()
    {
        var root = Directory.CreateTempSubdirectory("jarvis-fake-codex-approval-");
        var script = Path.Combine(root.FullName, "fake-codex.sh");
        await File.WriteAllTextAsync(script, "#!/bin/sh\nwhile IFS= read -r line; do\n  if echo \"$line\" | grep -q '\"method\":\"initialize\"'; then echo '{\"id\":1,\"result\":{}}'; fi\n  if echo \"$line\" | grep -q '\"method\":\"thread/start\"'; then echo '{\"id\":2,\"result\":{\"thread\":{\"id\":\"thread-approved\"}}}'; fi\n  if echo \"$line\" | grep -q '\"method\":\"turn/start\"'; then echo '{\"id\":3,\"result\":{\"turn\":{\"id\":\"turn-approved\"}}}'; echo '{\"id\":99,\"method\":\"item/commandExecution/requestApproval\",\"params\":{\"command\":\"pwd\",\"reason\":\"bounded command\"}}'; fi\n  if echo \"$line\" | grep -q '\"id\":99,\"result\":{\"decision\":\"acceptForSession\"'; then echo '{\"method\":\"turn/completed\",\"params\":{\"status\":\"completed\",\"summary\":\"approved completion\",\"artifacts\":[]}}'; fi\ndone\n");
        if (!OperatingSystem.IsWindows())
        {
            File.SetUnixFileMode(script, UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute);
        }

        try
        {
            var taskRoot = Directory.CreateDirectory(Path.Combine(root.FullName, "task-root")).FullName;
            var taskId = Guid.NewGuid();
            var executionId = Guid.NewGuid();
            var deviceId = Guid.NewGuid();
            var task = new TaskResponse(
                taskId,
                Guid.NewGuid(),
                null,
                "run the approved command",
                null,
                ["localFiles", "runCommands"],
                [],
                deviceId,
                deviceId,
                WorkerKindValue.Codex,
                TaskStatusValue.Running,
                0,
                1,
                null,
                null,
                null,
                null,
                null,
                1,
                1,
                1,
                null);
            var execution = new TaskExecutionResponse(
                executionId,
                taskId,
                deviceId,
                WorkerKindValue.Codex,
                null,
                null,
                null,
                TaskExecutionStatusValue.Running,
                "{}",
                null,
                [],
                1,
                null,
                1);
            var claim = new DeviceTaskClaimResponse(
                true,
                task,
                execution,
                "approval-owner",
                30_000,
                new CapabilityEnvelopeContract(ReadFiles: true, RunCommands: true, AllowedRoots: [taskRoot]));
            var controlPlane = new RecordingControlPlane();
            var options = Options.Create(new DeviceNodeOptions
            {
                CodexBinaryPath = script,
                CodexArguments = [],
                HeartbeatIntervalMs = 30_000,
                MaxRestartAttempts = 0,
                Capabilities = new CapabilityEnvelopeOptions
                {
                    ReadFiles = true,
                    RunCommands = true,
                    AllowedRoots = [root.FullName]
                }
            });
            var worker = new DeviceNodeWorker(
                options,
                controlPlane,
                NullLogger<DeviceNodeWorker>.Instance,
                new ImmediateApprovalWaiter(ApprovalDecisionValue.Approve, ApprovalScopeValue.TaskSession));

            await worker.ExecuteClaimAsync(
                claim,
                Jarvis.Application.Devices.CapabilityPolicy.Create(options.Value.Capabilities.ToEnvelope()),
                new CancellationTokenSource(TimeSpan.FromSeconds(5)).Token);

            Assert.Equal(ApprovalKindValue.Command, controlPlane.CreatedApproval?.Kind);
            Assert.Contains(controlPlane.Events, item => item.EventType == "task.completed" && item.ResultSummary == "approved completion");
        }
        finally
        {
            root.Delete(recursive: true);
        }
    }

    [Fact]
    public async System.Threading.Tasks.Task FakeJsonlCrashMovesToRecoveringAndResumesTheKnownThreadWithoutReplayingTurnStart()
    {
        var root = Directory.CreateTempSubdirectory("jarvis-fake-codex-recovery-");
        var taskRoot = Directory.CreateDirectory(Path.Combine(root.FullName, "task-root")).FullName;
        var marker = Path.Combine(root.FullName, "first-process-started");
        var replayMarker = Path.Combine(root.FullName, "unexpected-turn-replay");
        var script = Path.Combine(root.FullName, "recovering-codex.sh");
        await File.WriteAllTextAsync(script, $"#!/bin/sh\nif [ ! -f '{marker}' ]; then touch '{marker}'; first=1; else first=0; fi\nwhile IFS= read -r line; do\n  if echo \"$line\" | grep -q '\"method\":\"initialize\"'; then echo '{{\"id\":1,\"result\":{{}}}}'; fi\n  if [ \"$first\" = 1 ] && echo \"$line\" | grep -q '\"method\":\"thread/start\"'; then echo '{{\"id\":2,\"result\":{{\"thread\":{{\"id\":\"thread-recovered\"}}}}}}'; fi\n  if [ \"$first\" = 1 ] && echo \"$line\" | grep -q '\"method\":\"turn/start\"'; then echo '{{\"id\":3,\"result\":{{\"turn\":{{\"id\":\"turn-recovered\"}}}}}}'; exit 17; fi\n  if [ \"$first\" = 0 ] && echo \"$line\" | grep -q '\"method\":\"thread/resume\"'; then echo '{{\"id\":2,\"result\":{{\"thread\":{{\"id\":\"thread-recovered\"}}}}}}'; echo '{{\"method\":\"turn/completed\",\"params\":{{\"turn\":{{\"id\":\"turn-recovered\",\"status\":\"completed\"}},\"summary\":\"recovered completion\",\"artifacts\":[]}}}}'; fi\n  if [ \"$first\" = 0 ] && echo \"$line\" | grep -q '\"method\":\"turn/start\"'; then touch '{replayMarker}'; exit 18; fi\ndone\n");
        if (!OperatingSystem.IsWindows())
        {
            File.SetUnixFileMode(script, UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute);
        }

        try
        {
            var taskId = Guid.NewGuid();
            var executionId = Guid.NewGuid();
            var deviceId = Guid.NewGuid();
            var task = new TaskResponse(
                taskId,
                Guid.NewGuid(),
                null,
                "recover the interrupted turn",
                null,
                ["localFiles"],
                [],
                deviceId,
                deviceId,
                WorkerKindValue.Codex,
                TaskStatusValue.Running,
                0,
                1,
                null,
                null,
                null,
                null,
                null,
                1,
                1,
                1,
                null);
            var execution = new TaskExecutionResponse(
                executionId,
                taskId,
                deviceId,
                WorkerKindValue.Codex,
                null,
                null,
                null,
                TaskExecutionStatusValue.Running,
                "{}",
                null,
                [],
                1,
                null,
                1);
            var claim = new DeviceTaskClaimResponse(
                true,
                task,
                execution,
                "recovery-owner",
                30_000,
                new CapabilityEnvelopeContract(ReadFiles: true, AllowedRoots: [taskRoot]));
            var controlPlane = new RecordingControlPlane();
            var options = Options.Create(new DeviceNodeOptions
            {
                CodexBinaryPath = script,
                CodexArguments = [],
                MaxRestartAttempts = 1,
                RestartDelayMs = 1,
                HeartbeatIntervalMs = 30_000,
                Capabilities = new CapabilityEnvelopeOptions
                {
                    ReadFiles = true,
                    AllowedRoots = [root.FullName]
                }
            });
            var worker = new DeviceNodeWorker(
                options,
                controlPlane,
                NullLogger<DeviceNodeWorker>.Instance);

            await worker.ExecuteClaimAsync(
                claim,
                Jarvis.Application.Devices.CapabilityPolicy.Create(options.Value.Capabilities.ToEnvelope()),
                new CancellationTokenSource(TimeSpan.FromSeconds(5)).Token);

            Assert.Contains(controlPlane.Events, item => item.EventType == "task.recovering");
            Assert.Contains(controlPlane.Events, item => item.EventType == "task.completed" && item.ResultSummary == "recovered completion");
            Assert.False(File.Exists(replayMarker));
        }
        finally
        {
            root.Delete(recursive: true);
        }
    }

    [Fact]
    public async System.Threading.Tasks.Task PersistedTurnStartIntentWithoutTurnIdRefusesAutomaticReplayAfterNodeRestart()
    {
        var root = Directory.CreateTempSubdirectory("jarvis-fake-codex-uncertain-");
        var taskRoot = Directory.CreateDirectory(Path.Combine(root.FullName, "task-root")).FullName;
        var replayMarker = Path.Combine(root.FullName, "unexpected-turn-replay");
        var script = Path.Combine(root.FullName, "uncertain-codex.sh");
        await File.WriteAllTextAsync(script, $"#!/bin/sh\nwhile IFS= read -r line; do\n  if echo \"$line\" | grep -q '\"method\":\"initialize\"'; then echo '{{\"id\":1,\"result\":{{}}}}'; fi\n  if echo \"$line\" | grep -q '\"method\":\"thread/resume\"'; then echo '{{\"id\":2,\"result\":{{\"thread\":{{\"id\":\"thread-uncertain\"}}}}}}'; fi\n  if echo \"$line\" | grep -q '\"method\":\"turn/start\"'; then touch '{replayMarker}'; exit 19; fi\ndone\n");
        if (!OperatingSystem.IsWindows())
        {
            File.SetUnixFileMode(script, UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute);
        }

        try
        {
            var taskId = Guid.NewGuid();
            var executionId = Guid.NewGuid();
            var deviceId = Guid.NewGuid();
            var task = new TaskResponse(
                taskId,
                Guid.NewGuid(),
                null,
                "do not replay an uncertain turn",
                null,
                ["localFiles"],
                [],
                deviceId,
                deviceId,
                WorkerKindValue.Codex,
                TaskStatusValue.Recovering,
                0,
                1,
                null,
                null,
                null,
                null,
                null,
                1,
                1,
                1,
                null);
            var execution = new TaskExecutionResponse(
                executionId,
                taskId,
                deviceId,
                WorkerKindValue.Codex,
                null,
                "thread-uncertain",
                null,
                TaskExecutionStatusValue.Recovering,
                "{}",
                null,
                [],
                1,
                null,
                1,
                CodexTurnStartRequestedAtMs: 1);
            var claim = new DeviceTaskClaimResponse(
                true,
                task,
                execution,
                "uncertain-owner",
                30_000,
                new CapabilityEnvelopeContract(ReadFiles: true, AllowedRoots: [taskRoot]));
            var controlPlane = new RecordingControlPlane();
            var options = Options.Create(new DeviceNodeOptions
            {
                CodexBinaryPath = script,
                CodexArguments = [],
                MaxRestartAttempts = 1,
                RestartDelayMs = 1,
                Capabilities = new CapabilityEnvelopeOptions
                {
                    ReadFiles = true,
                    AllowedRoots = [root.FullName]
                }
            });
            var worker = new DeviceNodeWorker(
                options,
                controlPlane,
                NullLogger<DeviceNodeWorker>.Instance);

            await worker.ExecuteClaimAsync(
                claim,
                Jarvis.Application.Devices.CapabilityPolicy.Create(options.Value.Capabilities.ToEnvelope()),
                new CancellationTokenSource(TimeSpan.FromSeconds(5)).Token);

            Assert.False(File.Exists(replayMarker));
            Assert.Contains(controlPlane.Events, item =>
                item.EventType == "task.failed" && item.ErrorCode == "codex_turn_outcome_uncertain");
        }
        finally
        {
            root.Delete(recursive: true);
        }
    }

    [Fact]
    public void ApprovalResponsesUsePinnedEnumsAndNeverGrantOutsideTheCapabilityEnvelope()
    {
        var root = Directory.CreateTempSubdirectory("jarvis-phase4-permission-");
        try
        {
            var allowed = Path.Combine(root.FullName, "allowed");
            var outside = Path.Combine(root.FullName, "outside");
            Directory.CreateDirectory(allowed);
            Directory.CreateDirectory(outside);
            var policy = Jarvis.Application.Devices.CapabilityPolicy.Create(
                new Jarvis.Application.Devices.CapabilityEnvelope(
                    ReadFiles: true,
                    WriteFiles: true,
                    RunCommands: true,
                    Network: false,
                    AllowedRoots: [allowed]));
            var permissionParams = JsonSerializer.SerializeToElement(new
            {
                permissions = new
                {
                    fileSystem = new
                    {
                        read = new[] { Path.Combine(allowed, "input.txt"), Path.Combine(outside, "secret.txt") },
                        write = new[] { Path.Combine(allowed, "output.txt"), Path.Combine(outside, "escape.txt") }
                    },
                    network = new { enabled = true }
                }
            });

            Assert.Equal("accept", Decision(CodexApprovalResponseFactory.Create(
                "item/fileChange/requestApproval", ApprovalDecisionValue.Approve, ApprovalScopeValue.Once, null, policy)));
            Assert.Equal("acceptForSession", Decision(CodexApprovalResponseFactory.Create(
                "item/fileChange/requestApproval", ApprovalDecisionValue.Approve, ApprovalScopeValue.TaskSession, null, policy)));
            Assert.Equal("cancel", Decision(CodexApprovalResponseFactory.Create(
                "item/fileChange/requestApproval", ApprovalDecisionValue.Deny, ApprovalScopeValue.Once, null, policy)));

            var readOnlyPolicy = Jarvis.Application.Devices.CapabilityPolicy.Create(
                new Jarvis.Application.Devices.CapabilityEnvelope(ReadFiles: true, AllowedRoots: [allowed]));
            Assert.Equal("cancel", Decision(CodexApprovalResponseFactory.Create(
                "item/commandExecution/requestApproval", ApprovalDecisionValue.Approve, ApprovalScopeValue.Once, null, readOnlyPolicy)));
            Assert.Equal("cancel", Decision(CodexApprovalResponseFactory.Create(
                "item/fileChange/requestApproval", ApprovalDecisionValue.Approve, ApprovalScopeValue.Once, null, readOnlyPolicy)));
            Assert.Equal("cancel", Decision(CodexApprovalResponseFactory.Create(
                "item/fileChange/requestApproval",
                ApprovalDecisionValue.Approve,
                ApprovalScopeValue.Once,
                JsonSerializer.SerializeToElement(new { grantRoot = outside }),
                policy)));
            Assert.Equal("cancel", Decision(CodexApprovalResponseFactory.Create(
                "item/commandExecution/requestApproval",
                ApprovalDecisionValue.Approve,
                ApprovalScopeValue.Once,
                JsonSerializer.SerializeToElement(new { cwd = allowed, networkApprovalContext = new { host = "example.com" } }),
                policy)));

            using var approved = JsonDocument.Parse(JsonSerializer.Serialize(CodexApprovalResponseFactory.Create(
                "item/permissions/requestApproval", ApprovalDecisionValue.Approve, ApprovalScopeValue.Once, permissionParams, policy),
                JsonOptions));
            var permissions = approved.RootElement.GetProperty("permissions");
            Assert.Equal(
                [Path.Combine(allowed, "input.txt")],
                permissions.GetProperty("fileSystem").GetProperty("read").EnumerateArray().Select(item => item.GetString()));
            Assert.Equal(
                [Path.Combine(allowed, "output.txt")],
                permissions.GetProperty("fileSystem").GetProperty("write").EnumerateArray().Select(item => item.GetString()));
            Assert.False(permissions.GetProperty("network").GetProperty("enabled").GetBoolean());

            using var denied = JsonDocument.Parse(JsonSerializer.Serialize(CodexApprovalResponseFactory.Create(
                "item/permissions/requestApproval", ApprovalDecisionValue.Deny, ApprovalScopeValue.Once, permissionParams, policy),
                JsonOptions));
            Assert.Empty(denied.RootElement.GetProperty("permissions").GetProperty("fileSystem").GetProperty("read").EnumerateArray());
            Assert.Empty(denied.RootElement.GetProperty("permissions").GetProperty("fileSystem").GetProperty("write").EnumerateArray());
            Assert.False(denied.RootElement.GetProperty("permissions").GetProperty("network").GetProperty("enabled").GetBoolean());
        }
        finally
        {
            root.Delete(recursive: true);
        }

        static string? Decision(object value)
        {
            using var document = JsonDocument.Parse(JsonSerializer.Serialize(
                value,
                JsonOptions));
            return document.RootElement.GetProperty("decision").GetString();
        }
    }

    private sealed class FailingRuntime(string threadId) : FakeRuntime(threadId)
    {
        public override System.Threading.Tasks.Task<CodexTurnHandle> StartTurnAsync(string threadId, string input, CancellationToken cancellationToken = default) =>
            System.Threading.Tasks.Task.FromException<CodexTurnHandle>(new EndOfStreamException("fake process exited"));
    }

    private sealed class SuccessfulRuntime(string threadId) : FakeRuntime(threadId)
    {
    }

    private abstract class FakeRuntime(string threadId) : ICodexRuntime
    {
        public System.Threading.Tasks.Task InitializeAsync(CancellationToken cancellationToken = default) => System.Threading.Tasks.Task.CompletedTask;

        public System.Threading.Tasks.Task<CodexThreadHandle> StartThreadAsync(Jarvis.Application.Devices.CapabilityPolicy policy, string? cwd, CancellationToken cancellationToken = default) =>
            System.Threading.Tasks.Task.FromResult(new CodexThreadHandle(threadId, System.Text.Json.JsonSerializer.SerializeToElement(new { thread = new { id = threadId } })));

        public System.Threading.Tasks.Task<CodexThreadHandle> ResumeThreadAsync(string threadId, Jarvis.Application.Devices.CapabilityPolicy policy, string? cwd, CancellationToken cancellationToken = default) =>
            StartThreadAsync(policy, cwd, cancellationToken);

        public virtual System.Threading.Tasks.Task<CodexTurnHandle> StartTurnAsync(string threadId, string input, CancellationToken cancellationToken = default) =>
            System.Threading.Tasks.Task.FromResult(new CodexTurnHandle(threadId, "turn-1", System.Text.Json.JsonSerializer.SerializeToElement(new { turn = new { id = "turn-1" } })));

        public System.Threading.Tasks.Task InterruptTurnAsync(string threadId, string turnId, CancellationToken cancellationToken = default) => System.Threading.Tasks.Task.CompletedTask;

        public async IAsyncEnumerable<CodexRuntimeEvent> ReadEventsAsync([System.Runtime.CompilerServices.EnumeratorCancellation] CancellationToken cancellationToken = default)
        {
            await System.Threading.Tasks.Task.CompletedTask;
            yield break;
        }

        public System.Threading.Tasks.Task RespondToServerRequestAsync(CodexServerRequest request, object result, CancellationToken cancellationToken = default) => System.Threading.Tasks.Task.CompletedTask;

        public string StderrSummary => "fake";

        public ValueTask DisposeAsync() => ValueTask.CompletedTask;
    }

    private sealed class RecordingControlPlane : IDeviceNodeControlPlane
    {
        public Queue<ApprovalStatusValue> ApprovalStatuses { get; set; } = new([ApprovalStatusValue.Pending]);
        public int ApprovalPollCount { get; private set; }
        public ConcurrentQueue<DeviceTaskEventRequest> Events { get; } = new();
        public DeviceApprovalRequest? CreatedApproval { get; private set; }

        public System.Threading.Tasks.Task<DeviceHeartbeatResponse> HeartbeatAsync(DeviceHeartbeatRequest request, string idempotencyKey, CancellationToken cancellationToken) =>
            System.Threading.Tasks.Task.FromResult(new DeviceHeartbeatResponse(Guid.NewGuid(), DeviceStatusValue.Online, 0, request.Capabilities ?? [], 1));

        public System.Threading.Tasks.Task<DeviceTaskClaimResponse> ClaimAsync(DeviceTaskClaimRequest request, string idempotencyKey, CancellationToken cancellationToken) =>
            System.Threading.Tasks.Task.FromResult(new DeviceTaskClaimResponse(false, null, null, null, null));

        public System.Threading.Tasks.Task<DeviceActiveTaskListResponse> ListActiveAsync(CancellationToken cancellationToken) =>
            System.Threading.Tasks.Task.FromResult(new DeviceActiveTaskListResponse([]));

        public System.Threading.Tasks.Task<TaskResponse> GetTaskAsync(Guid taskId, CancellationToken cancellationToken) =>
            System.Threading.Tasks.Task.FromResult(new TaskResponse(taskId, Guid.NewGuid(), null, "goal", null, [], [], null, null, WorkerKindValue.Codex, TaskStatusValue.Running, 0, 1, null, null, null, null, null, 1, 0, 0, null));

        public System.Threading.Tasks.Task<DeviceApprovalStatusResponse> GetApprovalAsync(Guid taskId, Guid approvalId, CancellationToken cancellationToken)
        {
            ApprovalPollCount++;
            var status = ApprovalStatuses.Count > 1 ? ApprovalStatuses.Dequeue() : ApprovalStatuses.Peek();
            return System.Threading.Tasks.Task.FromResult(new DeviceApprovalStatusResponse(approvalId, taskId, Guid.NewGuid(), Guid.NewGuid(), status, status == ApprovalStatusValue.Approved ? ApprovalDecisionValue.Approve : null, null));
        }

        public System.Threading.Tasks.Task<DeviceTaskLeaseRenewResponse> RenewLeaseAsync(Guid taskId, DeviceTaskLeaseRenewRequest request, string idempotencyKey, CancellationToken cancellationToken) =>
            System.Threading.Tasks.Task.FromResult(new DeviceTaskLeaseRenewResponse(taskId, true, 1, TaskStatusValue.Running));

        public System.Threading.Tasks.Task<DeviceTaskEventResponse> AppendEventAsync(Guid taskId, DeviceTaskEventRequest request, string leaseOwner, string idempotencyKey, CancellationToken cancellationToken)
        {
            Events.Enqueue(request);
            return System.Threading.Tasks.Task.FromResult(new DeviceTaskEventResponse(taskId, request.ExecutionId, true, false, TaskStatusValue.Running, TaskExecutionStatusValue.Running));
        }

        public System.Threading.Tasks.Task<DeviceApprovalResponse> CreateApprovalAsync(Guid taskId, DeviceApprovalRequest request, string leaseOwner, string idempotencyKey, CancellationToken cancellationToken)
        {
            CreatedApproval = request;
            return System.Threading.Tasks.Task.FromResult(new DeviceApprovalResponse(Guid.NewGuid(), ApprovalStatusValue.Pending));
        }
    }

    private sealed class ImmediateApprovalWaiter(
        ApprovalDecisionValue decision,
        ApprovalScopeValue scope) : IDeviceApprovalDecisionWaiter
    {
        public Task<DeviceApprovalResolution?> WaitAsync(Guid taskId, Guid approvalId, CancellationToken cancellationToken) =>
            Task.FromResult<DeviceApprovalResolution?>(new DeviceApprovalResolution(decision, scope));
    }

    private sealed class RecordingIdentityStore(DeviceNodeIdentity? identity) : IDeviceNodeIdentityStore
    {
        public DeviceNodeIdentity? Saved { get; private set; }

        public Task<DeviceNodeIdentity?> LoadAsync(CancellationToken cancellationToken = default) =>
            Task.FromResult(identity);

        public Task SaveAsync(DeviceNodeIdentity value, CancellationToken cancellationToken = default)
        {
            Saved = value;
            return Task.CompletedTask;
        }
    }

    private sealed class RecordingRegistrationClient : IDeviceNodeRegistrationClient
    {
        public int Calls { get; private set; }
        public DeviceRegistrationResponse? Response { get; init; }

        public Task<DeviceRegistrationResponse> RegisterAsync(
            DeviceRegistrationRequest request,
            string bootstrapBearer,
            string idempotencyKey,
            CancellationToken cancellationToken = default)
        {
            Calls++;
            return Task.FromResult(Response ?? throw new InvalidOperationException("Registration was not expected."));
        }
    }
}
