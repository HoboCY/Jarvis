using System.Collections.Concurrent;
using System.Diagnostics;
using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text.Json;
using Jarvis.Api.IntegrationTests;
using Jarvis.Application.Devices;
using Jarvis.Application.Realtime;
using Jarvis.Contracts;
using Jarvis.DeviceNode;
using Jarvis.DeviceNode.Codex;
using Jarvis.Domain.Conversations;
using Jarvis.Domain.Memory;
using Jarvis.Domain.Notifications;
using Jarvis.Infrastructure.Data;
using Jarvis.Infrastructure.Outbox;
using Jarvis.Infrastructure.Tasks;
using Microsoft.EntityFrameworkCore;
using Microsoft.AspNetCore.SignalR.Client;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Options;
using Xunit;

namespace Jarvis.E2E.Tests;

/// <summary>
/// The Phase 6 catalog is executable: each named scenario starts at a public
/// HTTP or Device Node seam and asserts durable state at the end of its chain.
/// Provider fakes are test seams only; they are not live-provider evidence.
/// </summary>
public sealed class Phase6E2ESmokeTests
{
    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web);

    [Fact]
    public async Task Scenario_TextInput_PersistsExactlyOnceAndTypedP95MeetsBudget()
    {
        await using var factory = new TestApplicationFactory(
            databasePath: null,
            deleteDatabaseOnDispose: true,
            outboxPublisher: null,
            realtimeProvider: new E2EFakeRealtimeClientSecretProvider());
        using var client = AuthenticatedClient(factory);
        var conversation = await CreateConversationAsync(client, "e2e text input");

        var first = await AddTypedMessageAsync(client, conversation.Id, "text-first", "hello");
        var replay = await AddTypedMessageAsync(client, conversation.Id, "text-first", "hello");
        Assert.Equal(first, replay);

        var device = await BootstrapDesktopDeviceAsync(client);
        var secret = await CreateSecretAsync(client, conversation.Id, device.DeviceId, "text-assistant-secret");
        await PostAsync(
            client,
            $"/api/v1/realtime/sessions/{secret.RealtimeSessionId:D}/connected",
            new RealtimeSessionConnectedRequest("e2e-text-session"),
            "text-assistant-connected");

        _ = await AddTypedMessageAsync(client, conversation.Id, "typed-warmup", "warmup");
        var samples = new List<double>(20);
        for (var index = 0; index < 20; index++)
        {
            var started = Stopwatch.GetTimestamp();
            using var request = new HttpRequestMessage(
                HttpMethod.Post,
                $"/api/v1/conversations/{conversation.Id:D}/messages/typed")
            {
                Content = JsonContent.Create(new TypedMessageRequest(
                    $"typed-p95-{index}",
                    $"typed payload {index}"))
            };
            request.Headers.Add("Idempotency-Key", $"typed-p95-key-{index}");
            using var response = await client.SendAsync(request);
            response.EnsureSuccessStatusCode();
            samples.Add(Stopwatch.GetElapsedTime(started).TotalMilliseconds);
        }

        await PostAsync(
            client,
            $"/api/v1/conversations/{conversation.Id:D}/realtime-events:ingest",
            new RealtimeEventsIngestRequest(
                1,
                [new(
                    "text-assistant-reply",
                    "text-assistant-item",
                    secret.RealtimeSessionId,
                    MessageRoleValue.Assistant,
                    "text",
                    RealtimeEventStatusValue.Completed,
                    "text-only assistant reply")]),
            "text-assistant-reply-event");

        var detail = await client.GetFromJsonAsync<ConversationResponse>(
            $"/api/v1/conversations/{conversation.Id:D}");
        Assert.NotNull(detail);
        Assert.Equal(23, detail!.MessageCount);
        Assert.Contains(detail.Messages, message =>
            message.Role == MessageRoleValue.Assistant
            && message.OutputModality == MessageOutputModalityValue.Text
            && message.Text == "text-only assistant reply");

        samples.Sort();
        var p95 = samples[(int)Math.Ceiling(samples.Count * .95) - 1];
        Assert.True(p95 <= 300, $"typed message p95 was {p95:F1}ms");
    }

    [Fact]
    public async Task Scenario_CrossModalReference_BindsTypedMessageToConnectedRealtimeSession()
    {
        var provider = new E2EFakeRealtimeClientSecretProvider();
        await using var factory = new TestApplicationFactory(
            databasePath: null,
            deleteDatabaseOnDispose: true,
            outboxPublisher: null,
            realtimeProvider: provider);
        using var client = AuthenticatedClient(factory);
        var conversation = await CreateConversationAsync(client, "e2e cross modal");
        var device = await BootstrapDesktopDeviceAsync(client);
        var secret = await CreateSecretAsync(client, conversation.Id, device.DeviceId, "cross-modal-secret");
        await PostAsync(
            client,
            $"/api/v1/realtime/sessions/{secret.RealtimeSessionId:D}/connected",
            new RealtimeSessionConnectedRequest("e2e-voice-session"),
            "cross-modal-connected");

        await PostAsync(
            client,
            $"/api/v1/conversations/{conversation.Id:D}/realtime-events:ingest",
            new RealtimeEventsIngestRequest(
                1,
                [new(
                    "cross-voice-event",
                    "cross-voice-item",
                    secret.RealtimeSessionId,
                    MessageRoleValue.User,
                    "voice",
                    RealtimeEventStatusValue.Completed,
                    "voice context")]),
            "cross-modal-event");
        await AddTypedMessageAsync(
            client,
            conversation.Id,
            "cross-typed",
            "continue that voice context",
            secret.RealtimeSessionId);
        var nextSecret = await CreateSecretAsync(
            client,
            conversation.Id,
            device.DeviceId,
            "cross-modal-new-session");
        Assert.True(nextSecret.ContextVersion > secret.ContextVersion);
        Assert.Contains(
            provider.Contexts.SelectMany(context => context.RecentMessages),
            message => message.Text == "voice context");

        var detail = await client.GetFromJsonAsync<ConversationResponse>(
            $"/api/v1/conversations/{conversation.Id:D}");
        Assert.NotNull(detail);
        Assert.Contains(detail!.Messages, message =>
            message.InputModality == MessageInputModalityValue.Voice
            && message.Text == "voice context");
        Assert.Contains(detail.Messages, message =>
            message.ClientRequestId == "cross-typed"
            && message.RealtimeSessionId == secret.RealtimeSessionId);
    }

    [Fact]
    public async Task Scenario_TypedInterruptsVoice_PersistsInterruptedVoiceAndContinuesText()
    {
        var provider = new E2EFakeRealtimeClientSecretProvider();
        await using var factory = new TestApplicationFactory(
            databasePath: null,
            deleteDatabaseOnDispose: true,
            outboxPublisher: null,
            realtimeProvider: provider);
        using var client = AuthenticatedClient(factory);
        var conversation = await CreateConversationAsync(client, "e2e interruption");
        var device = await BootstrapDesktopDeviceAsync(client);
        var secret = await CreateSecretAsync(client, conversation.Id, device.DeviceId, "interrupt-secret");
        await PostAsync(
            client,
            $"/api/v1/realtime/sessions/{secret.RealtimeSessionId:D}/connected",
            new RealtimeSessionConnectedRequest("e2e-interrupt-session"),
            "interrupt-connected");
        await PostAsync(
            client,
            $"/api/v1/conversations/{conversation.Id:D}/realtime-events:ingest",
            new RealtimeEventsIngestRequest(
                1,
                [new(
                    "interrupt-stream",
                    "interrupt-item",
                    secret.RealtimeSessionId,
                    MessageRoleValue.Assistant,
                    "audioWithTranscript",
                    RealtimeEventStatusValue.Streaming,
                    "正在说")]),
            "interrupt-stream-event");

        await AddTypedMessageAsync(
            client,
            conversation.Id,
            "interrupt-typed",
            "stop and answer in text",
            secret.RealtimeSessionId);
        await PostAsync(
            client,
            $"/api/v1/conversations/{conversation.Id:D}/realtime-events:ingest",
            new RealtimeEventsIngestRequest(
                1,
                [new(
                    "interrupt-stream-ended",
                    "interrupt-item",
                    secret.RealtimeSessionId,
                    MessageRoleValue.Assistant,
                    "audioWithTranscript",
                    RealtimeEventStatusValue.Interrupted,
                    "已被文字输入打断")]),
            "interrupt-stream-ended-event");
        await PostAsync(
            client,
            $"/api/v1/realtime/sessions/{secret.RealtimeSessionId:D}/ended",
            new RealtimeSessionEndedRequest("typed input interrupted voice"),
            "interrupt-ended");
        var replySession = await CreateSecretAsync(
            client,
            conversation.Id,
            device.DeviceId,
            "interrupt-reply-session");
        await PostAsync(
            client,
            $"/api/v1/realtime/sessions/{replySession.RealtimeSessionId:D}/connected",
            new RealtimeSessionConnectedRequest("e2e-interrupt-reply-session"),
            "interrupt-reply-connected");
        await PostAsync(
            client,
            $"/api/v1/conversations/{conversation.Id:D}/realtime-events:ingest",
            new RealtimeEventsIngestRequest(
                1,
                [new(
                    "interrupt-text-reply",
                    "interrupt-text-reply-item",
                    replySession.RealtimeSessionId,
                    MessageRoleValue.Assistant,
                    "text",
                    RealtimeEventStatusValue.Completed,
                    "text-only answer after interruption")]),
            "interrupt-text-reply-event");

        var detail = await client.GetFromJsonAsync<ConversationResponse>(
            $"/api/v1/conversations/{conversation.Id:D}");
        Assert.NotNull(detail);
        Assert.Contains(detail!.Messages, message => message.Status == MessageStatusValue.Interrupted);
        Assert.Contains(detail.Messages, message => message.ClientRequestId == "interrupt-typed");
        Assert.Contains(detail.Messages, message =>
            message.Role == MessageRoleValue.Assistant
            && message.OutputModality == MessageOutputModalityValue.Text
            && message.Text == "text-only answer after interruption");
    }

    [Fact]
    public async Task Scenario_BackgroundDelegation_ReturnsTaskIdUnderOneSecondAndQueuesWork()
    {
        await using var factory = new TestApplicationFactory();
        using var client = AuthenticatedClient(factory);
        var conversation = await CreateConversationAsync(client, "e2e delegation");
        var started = Stopwatch.GetTimestamp();
        using var response = await PostAsync(
            client,
            "/api/v1/tasks",
            new CreateTaskRequest(
                conversation.Id,
                [],
                "delegate a bounded local report",
                "report",
                [],
                CapabilityEnvelope: null),
            "e2e-task-create");
        var elapsed = Stopwatch.GetElapsedTime(started).TotalMilliseconds;

        Assert.Equal(HttpStatusCode.Accepted, response.StatusCode);
        var accepted = await response.Content.ReadFromJsonAsync<TaskAcceptedResponse>();
        Assert.NotNull(accepted);
        Assert.NotEqual(Guid.Empty, accepted!.TaskId);
        Assert.Equal(TaskStatusValue.Queued, accepted.Status);
        Assert.True(elapsed <= 1_000, $"task acceptance took {elapsed:F1}ms");

        var task = await client.GetFromJsonAsync<TaskResponse>($"/api/v1/tasks/{accepted.TaskId:D}");
        Assert.NotNull(task);
        Assert.Equal(TaskStatusValue.Queued, task!.Status);
        Assert.Equal(accepted.TaskId, task.Id);

        await using (var scope = factory.Services.CreateAsyncScope())
        {
            Assert.True(await scope.ServiceProvider.GetRequiredService<FakeDelayWorker>().ProcessOneAsync());
        }
        var completed = await client.GetFromJsonAsync<TaskResponse>($"/api/v1/tasks/{accepted.TaskId:D}");
        Assert.NotNull(completed);
        Assert.Equal(TaskStatusValue.Succeeded, completed!.Status);
        var unread = await client.GetFromJsonAsync<NotificationListResponse>("/api/v1/notifications?status=unread");
        var notification = Assert.Single(unread!.Items, item => item.TaskId == accepted.TaskId);
        using var delivered = await PostAsync(
            client,
            $"/api/v1/notifications/{notification.Id:D}/delivered",
            new { },
            "e2e-delegation-delivered");
        delivered.EnsureSuccessStatusCode();
        using var read = await PostAsync(
            client,
            $"/api/v1/notifications/{notification.Id:D}/read",
            new { },
            "e2e-delegation-read");
        read.EnsureSuccessStatusCode();
    }

    [Fact]
    public async Task Scenario_NotificationOfflinePull_PublishesAndPullsWithoutLossWithinTwoSeconds()
    {
        await using var factory = new TestApplicationFactory();
        using var client = AuthenticatedClient(factory);
        var conversation = await CreateConversationAsync(client, "e2e notification");
        await using var connection = new HubConnectionBuilder()
            .WithUrl(new Uri(factory.Server.BaseAddress, "/hubs/client"), options =>
            {
                options.HttpMessageHandlerFactory = _ => factory.Server.CreateHandler();
                options.AccessTokenProvider = () => Task.FromResult<string?>(factory.Token);
            })
            .Build();
        var pushedWhileConnected = new ConcurrentQueue<OutboxEventEnvelope>();
        connection.On<OutboxEventEnvelope>(
            "notification.created",
            envelope => pushedWhileConnected.Enqueue(envelope));
        await connection.StartAsync();
        Assert.Equal(HubConnectionState.Connected, connection.State);
        await connection.StopAsync();
        Assert.Equal(HubConnectionState.Disconnected, connection.State);

        var taskId = await CreateTaskAsync(client, conversation.Id, "complete offline");
        var started = Stopwatch.GetTimestamp();

        await using (var scope = factory.Services.CreateAsyncScope())
        {
            Assert.True(await scope.ServiceProvider.GetRequiredService<FakeDelayWorker>().ProcessOneAsync());
        }

        var dispatcher = factory.Services.GetRequiredService<OutboxDispatcher>();
        Assert.True(await dispatcher.ProcessOnceAsync() > 0);
        Assert.Empty(pushedWhileConnected);
        await using (var scope = factory.Services.CreateAsyncScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<JarvisDbContext>();
            var published = Assert.Single(
                await db.OutboxMessages
                    .Where(item => item.EventType == "notification.created")
                    .ToListAsync(),
                item => item.PayloadJson.Contains(taskId.ToString(), StringComparison.Ordinal));
            Assert.NotNull(published.PublishedAtMs);
            Assert.Equal(1, await db.Notifications.CountAsync(item => item.TaskId == taskId));
        }

        await connection.StartAsync();
        Assert.Equal(HubConnectionState.Connected, connection.State);
        var unread = await client.GetFromJsonAsync<NotificationListResponse>(
            "/api/v1/notifications?status=unread");
        var replayedPull = await client.GetFromJsonAsync<NotificationListResponse>(
            "/api/v1/notifications?status=unread");
        var elapsed = Stopwatch.GetElapsedTime(started).TotalMilliseconds;

        Assert.NotNull(unread);
        Assert.NotNull(replayedPull);
        var notification = Assert.Single(unread!.Items, item => item.TaskId == taskId);
        Assert.Equal("task.completed", notification.Type);
        var uiProjection = new Dictionary<Guid, NotificationResponse>();
        foreach (var item in unread.Items.Concat(replayedPull!.Items))
        {
            uiProjection.TryAdd(item.Id, item);
        }

        Assert.Single(uiProjection);
        Assert.Equal(notification.Id, uiProjection.Single().Key);
        Assert.True(elapsed <= 2_000, $"notification publish/pull took {elapsed:F1}ms");
    }

    [Fact]
    public async Task Scenario_CodexApproval_PropagatesBoundDecisionFromUiToDevice()
    {
        var root = Directory.CreateTempSubdirectory("jarvis-e2e-approval-");
        var script = Path.Combine(root.FullName, "fake-codex.sh");
        var scriptContents = """
#!/bin/sh
set -eu
profile_id=""
for argument in "$@"; do
  case "$argument" in
    default_permissions=*) profile_id=$(printf '%s\n' "$argument" | sed 's/^default_permissions="//; s/"$//');;
  esac
done
while IFS= read -r line; do
  if echo "$line" | grep -q '"method":"initialize"'; then echo '{"id":1,"result":{}}'; fi
  if echo "$line" | grep -q '"method":"thread/start"'; then printf '{"id":2,"result":{"thread":{"id":"thread-e2e-approval"},"activePermissionProfile":{"id":"%s"}}}\n' "$profile_id"; fi
  if echo "$line" | grep -q '"method":"turn/start"'; then echo '{"id":3,"result":{"turn":{"id":"turn-e2e-approval"}}}'; echo '{"id":99,"method":"item/commandExecution/requestApproval","params":{"command":"pwd","reason":"e2e approval"}}'; fi
  if echo "$line" | grep -q '"result"' && echo "$line" | grep -q '"decision"'; then echo '{"method":"turn/completed","params":{"turn":{"id":"turn-e2e-approval","status":"completed"},"summary":"approved completion","artifacts":[]}}'; fi
done
""";
        await File.WriteAllTextAsync(script, scriptContents);
        if (!OperatingSystem.IsWindows())
        {
            File.SetUnixFileMode(script, UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute);
        }

        try
        {
            await using var factory = new TestApplicationFactory();
            using var ui = AuthenticatedClient(factory);
            var conversation = await CreateConversationAsync(ui, "e2e approval");
            var taskId = await CreateTaskAsync(ui, conversation.Id, "write approved report", codex: true);
            var device = await RegisterDeviceAsync(ui, "e2e approval node");
            var codexHome = CreateSecureDirectory(Path.Combine(root.FullName, "codex-home"));
            using var node = factory.CreateClient();
            var nodeOptions = new DeviceNodeOptions
            {
                DeviceId = device.DeviceId,
                DeviceCredential = device.DeviceCredential,
                CodexHome = codexHome,
                CodexBinaryPath = script,
                CodexArguments = [],
                PollingIntervalMs = 25,
                HeartbeatIntervalMs = 1_000,
                MaxRestartAttempts = 0,
                Capabilities = new CapabilityEnvelopeOptions
                {
                    ReadFiles = true,
                    AllowedRoots = [Path.GetTempPath()]
                }
            };
            var options = Options.Create(nodeOptions);
            var controlPlane = new DeviceNodeHttpClient(node, options);
            await controlPlane.HeartbeatAsync(
                new DeviceHeartbeatRequest(["localFiles"], [Path.GetTempPath()]),
                "e2e-approval-heartbeat",
                CancellationToken.None);
            var claim = await controlPlane.ClaimAsync(
                new DeviceTaskClaimRequest(
                    "e2e-approval-owner",
                    new CapabilityEnvelopeContract(ReadFiles: true, AllowedRoots: [Path.GetTempPath()])),
                "e2e-approval-claim",
                CancellationToken.None);
            Assert.True(claim.Claimed);
            Assert.NotNull(claim.Execution);

            var waiter = new PollingApprovalDecisionWaiter(controlPlane, options, TimeProvider.System);
            var worker = new DeviceNodeWorker(
                options,
                controlPlane,
                Microsoft.Extensions.Logging.Abstractions.NullLogger<DeviceNodeWorker>.Instance,
                waiter);
            using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(10));
            var execution = worker.ExecuteClaimAsync(
                claim,
                CapabilityPolicy.Create(nodeOptions.Capabilities.ToEnvelope()),
                timeout.Token);
            ApprovalResponse? pendingApproval = null;
            for (var attempt = 0; attempt < 200 && pendingApproval is null; attempt++)
            {
                var pending = await ui.GetFromJsonAsync<ApprovalListResponse>("/api/v1/approvals?status=pending");
                pendingApproval = pending?.Items.FirstOrDefault(item => item.TaskId == taskId);
                if (pendingApproval is null)
                {
                    await Task.Delay(25, timeout.Token);
                }
            }

            Assert.NotNull(pendingApproval);
            using var decision = await PostAsync(
                ui,
                $"/api/v1/approvals/{pendingApproval!.Id:D}/decision",
                new ApprovalDecisionRequest(
                    ApprovalDecisionValue.Approve,
                    ApprovalScopeValue.Once,
                    "e2e-approval-decision"),
                "e2e-approval-decision-key");
            decision.EnsureSuccessStatusCode();
            await execution;

            var completed = await ui.GetFromJsonAsync<TaskResponse>($"/api/v1/tasks/{taskId:D}");
            Assert.NotNull(completed);
            Assert.Equal(TaskStatusValue.Succeeded, completed!.Status);
            Assert.Equal(TaskExecutionStatusValue.Succeeded, completed.Execution?.Status);
            Assert.Equal("thread-e2e-approval", completed.Execution?.CodexThreadId);
            Assert.Equal("turn-e2e-approval", completed.Execution?.CodexTurnId);
            Assert.Contains("approved completion", completed.ResultSummary, StringComparison.Ordinal);
        }
        finally
        {
            root.Delete(recursive: true);
        }
    }

    [Fact]
    public async Task Scenario_CodexCrashRecovery_UsesChildProcessExitAndFailsUncertainTurnWithoutReplay()
    {
        var root = Directory.CreateTempSubdirectory("jarvis-e2e-codex-crash-");
        var databasePath = Path.Combine(root.FullName, "control-plane.db");
        var markerPath = Path.Combine(root.FullName, "codex-requests.log");
        var codexPath = Path.Combine(root.FullName, "fake-codex.sh");
        var escapedMarkerPath = markerPath.Replace("'", "'\\''", StringComparison.Ordinal);
        var scriptContents = """
#!/bin/sh
set -eu
marker='__MARKER__'
profile_id=""
for argument in "$@"; do
  case "$argument" in
    default_permissions=*) profile_id=$(printf '%s\n' "$argument" | sed 's/^default_permissions="//; s/"$//');;
  esac
done
while IFS= read -r line; do
  case "$line" in
    *'"method":"initialize"'*) printf '%s\n' '{"id":1,"result":{}}';;
    *'"method":"thread/start"'*) printf '{"id":2,"result":{"thread":{"id":"thread-e2e-crash"},"activePermissionProfile":{"id":"%s"}}}\n' "$profile_id";;
    *'"method":"turn/start"'*) printf '%s\n' turn-start >> "$marker"; exit 42;;
  esac
done
""".Replace("__MARKER__", escapedMarkerPath, StringComparison.Ordinal);
        await File.WriteAllTextAsync(codexPath, scriptContents);
        if (!OperatingSystem.IsWindows())
        {
            File.SetUnixFileMode(codexPath, UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute);
        }

        try
        {
            await using var factory = new TestApplicationFactory(
                databasePath,
                deleteDatabaseOnDispose: true,
                outboxPublisher: null);
            using var ui = AuthenticatedClient(factory);
            var conversation = await CreateConversationAsync(ui, "e2e codex crash");
            var taskId = await CreateTaskAsync(ui, conversation.Id, "crash during turn start", codex: true);
            var device = await RegisterDeviceAsync(ui, "e2e crashing codex node");
            var codexHome = CreateSecureDirectory(Path.Combine(root.FullName, "codex-home"));
            using var node = factory.CreateClient();
            var nodeOptions = new DeviceNodeOptions
            {
                DeviceId = device.DeviceId,
                DeviceCredential = device.DeviceCredential,
                CodexHome = codexHome,
                WorkingDirectory = root.FullName,
                CodexBinaryPath = codexPath,
                CodexArguments = [],
                MaxRestartAttempts = 0,
                PollingIntervalMs = 25,
                HeartbeatIntervalMs = 1_000,
                Capabilities = new CapabilityEnvelopeOptions
                {
                    ReadFiles = true,
                    AllowedRoots = [Path.GetTempPath()]
                }
            };
            var options = Options.Create(nodeOptions);
            var controlPlane = new DeviceNodeHttpClient(node, options);
            await controlPlane.HeartbeatAsync(
                new DeviceHeartbeatRequest(["localFiles"], [Path.GetTempPath()]),
                "e2e-crash-heartbeat",
                CancellationToken.None);
            var claim = await controlPlane.ClaimAsync(
                new DeviceTaskClaimRequest(
                    "e2e-crash-owner",
                    new CapabilityEnvelopeContract(ReadFiles: true, AllowedRoots: [Path.GetTempPath()])),
                "e2e-crash-claim",
                CancellationToken.None);
            Assert.True(claim.Claimed);
            Assert.NotNull(claim.Execution);

            var worker = new DeviceNodeWorker(
                options,
                controlPlane,
                Microsoft.Extensions.Logging.Abstractions.NullLogger<DeviceNodeWorker>.Instance);
            using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(10));
            await worker.ExecuteClaimAsync(
                claim,
                CapabilityPolicy.Create(nodeOptions.Capabilities.ToEnvelope()),
                timeout.Token);

            var completed = await ui.GetFromJsonAsync<TaskResponse>($"/api/v1/tasks/{taskId:D}");
            Assert.NotNull(completed);
            Assert.Equal(TaskStatusValue.Failed, completed!.Status);
            Assert.Equal(TaskExecutionStatusValue.Failed, completed.Execution?.Status);
            Assert.Equal("thread-e2e-crash", completed.Execution?.CodexThreadId);
            Assert.Null(completed.Execution?.CodexTurnId);
            Assert.NotNull(completed.Execution?.CodexTurnStartRequestedAtMs);
            Assert.Equal("codex_turn_outcome_uncertain", completed.ErrorCode);

            await using var scope = factory.Services.CreateAsyncScope();
            var db = scope.ServiceProvider.GetRequiredService<JarvisDbContext>();
            var events = await db.TaskEvents
                .Where(item => item.TaskId == taskId)
                .OrderBy(item => item.Sequence)
                .ToListAsync();
            Assert.Contains(events, item => item.EventType == "codex.turn.starting");
            Assert.Contains(events, item => item.EventType == "task.failed");
            Assert.Equal(1, await db.Notifications.CountAsync(item => item.TaskId == taskId));
            Assert.Equal("task.failed", (await db.Notifications.SingleAsync(item => item.TaskId == taskId)).Type);

            Assert.True(File.Exists(markerPath), "The controlled Codex child did not receive turn/start.");
            Assert.Equal(["turn-start"], await File.ReadAllLinesAsync(markerPath));
        }
        finally
        {
            root.Delete(recursive: true);
        }
    }

    [Fact]
    public async Task Scenario_SessionRotationAndBackendRestart_PreservesConversationAndRealtimeContext()
    {
        var databasePath = Path.Combine(Path.GetTempPath(), $"jarvis-e2e-restart-{Guid.NewGuid():N}.db");
        var firstProvider = new E2EFakeRealtimeClientSecretProvider();
        Guid conversationId;
        Guid firstSessionId;
        Guid rotatedSessionId;
        try
        {
            await using (var firstFactory = new TestApplicationFactory(
                databasePath,
                deleteDatabaseOnDispose: false,
                outboxPublisher: null,
                realtimeProvider: firstProvider))
            {
                using var client = AuthenticatedClient(firstFactory);
                var conversation = await CreateConversationAsync(client, "e2e restart rotation");
                conversationId = conversation.Id;
                var device = await BootstrapDesktopDeviceAsync(client);
                var first = await CreateSecretAsync(client, conversation.Id, device.DeviceId, "restart-session-1");
                firstSessionId = first.RealtimeSessionId;
                await PostAsync(
                    client,
                    $"/api/v1/realtime/sessions/{firstSessionId:D}/connected",
                    new RealtimeSessionConnectedRequest("external-one"),
                    "restart-connected-1");
                await PostAsync(
                    client,
                    $"/api/v1/conversations/{conversation.Id:D}/realtime-events:ingest",
                    new RealtimeEventsIngestRequest(
                        1,
                        [new(
                            "restart-event-1",
                            "restart-item-1",
                            firstSessionId,
                            MessageRoleValue.User,
                            "voice",
                            RealtimeEventStatusValue.Completed,
                            "before restart")]),
                    "restart-events-1");
                await using (var seedScope = firstFactory.Services.CreateAsyncScope())
                {
                    var contextDb = seedScope.ServiceProvider.GetRequiredService<JarvisDbContext>();
                    var userId = (await contextDb.Users.Select(item => (Guid?)item.Id).SingleAsync())!.Value;
                    var nowMs = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
                    var summary = ConversationSummary.Create(
                        Guid.CreateVersion7(),
                        conversation.Id,
                        1,
                        1,
                        "persistent transcript summary: before restart voice transcript",
                        "e2e-summary",
                        nowMs);
                    contextDb.ConversationSummaries.Add(summary);
                    var conversationEntity = await contextDb.Conversations.SingleAsync(item => item.Id == conversation.Id);
                    conversationEntity.SetCurrentSummary(summary.Id);
                    var contextTask = Jarvis.Domain.Tasks.Task.Create(
                        Guid.CreateVersion7(),
                        userId,
                        conversation.Id,
                        "context task survives restart",
                        "context result",
                        "[]",
                        "[]",
                        null,
                        Jarvis.Domain.Tasks.WorkerKind.Internal,
                        0,
                        nowMs,
                        capabilityEnvelopeJson: "{}");
                    var notificationTask = Jarvis.Domain.Tasks.Task.Create(
                        Guid.CreateVersion7(),
                        userId,
                        conversation.Id,
                        "context notification task",
                        "context notification body",
                        "[]",
                        "[]",
                        null,
                        Jarvis.Domain.Tasks.WorkerKind.Internal,
                        0,
                        nowMs,
                        capabilityEnvelopeJson: "{}");
                    notificationTask.Assign("notification-owner", nowMs + 60_000, nowMs);
                    notificationTask.Start(nowMs);
                    notificationTask.MarkSucceeded("context notification body", nowMs);
                    contextDb.Tasks.Add(contextTask);
                    contextDb.Tasks.Add(notificationTask);
                    contextDb.Notifications.Add(Notification.Create(
                        Guid.CreateVersion7(),
                        userId,
                        conversation.Id,
                        notificationTask.Id,
                        "task.completed",
                        NotificationSeverity.Success,
                        "context notification",
                        "context notification body",
                        $"e2e-context:{contextTask.Id:D}",
                        nowMs));
                    contextDb.MemoryFacts.Add(MemoryFact.CreateDirect(
                        Guid.CreateVersion7(),
                        userId,
                        "context.preference",
                        JsonSerializer.Serialize("remember transcript"),
                        null,
                        sensitive: false,
                        nowMs));
                    await contextDb.SaveChangesAsync();
                }
                var rotated = await CreateSecretAsync(client, conversation.Id, device.DeviceId, "restart-session-2");
                rotatedSessionId = rotated.RealtimeSessionId;
                await PostAsync(
                    client,
                    $"/api/v1/realtime/sessions/{firstSessionId:D}/ended",
                    new RealtimeSessionEndedRequest("idle rotation", RealtimeSessionStatusValue.Rotated),
                    "restart-ended-1");
                await PostAsync(
                    client,
                    $"/api/v1/realtime/sessions/{rotatedSessionId:D}/connected",
                    new RealtimeSessionConnectedRequest("external-two"),
                    "restart-connected-2");
                await PostAsync(
                    client,
                    $"/api/v1/conversations/{conversation.Id:D}/realtime-events:ingest",
                    new RealtimeEventsIngestRequest(
                        1,
                        [new(
                            "restart-event-2",
                            "restart-item-2",
                            rotatedSessionId,
                            MessageRoleValue.User,
                            "typedText",
                            RealtimeEventStatusValue.Completed,
                            "after rotation")]),
                    "restart-events-2");
            }

            var secondProvider = new E2EFakeRealtimeClientSecretProvider();
            await using var secondFactory = new TestApplicationFactory(
                databasePath,
                deleteDatabaseOnDispose: true,
                outboxPublisher: null,
                realtimeProvider: secondProvider);
            using var restartedClient = AuthenticatedClient(secondFactory);
            var detail = await restartedClient.GetFromJsonAsync<ConversationResponse>(
                $"/api/v1/conversations/{conversationId:D}");
            Assert.NotNull(detail);
            Assert.Contains(detail!.Messages, message => message.RealtimeSessionId == firstSessionId);
            Assert.Contains(detail.Messages, message => message.RealtimeSessionId == rotatedSessionId);
            var newSession = await CreateSecretAsync(
                restartedClient,
                conversationId,
                (await BootstrapDesktopDeviceAsync(restartedClient)).DeviceId,
                "restart-session-after-rebuild");
            Assert.True(newSession.ContextVersion > 0);
            Assert.Contains(
                secondProvider.Contexts,
                context => context.Summary.Contains("before restart voice transcript", StringComparison.Ordinal)
                    && context.TasksAndResults.Contains("context task survives restart", StringComparison.Ordinal)
                    && context.TasksAndResults.Contains("context notification body", StringComparison.Ordinal)
                    && context.MemoryFacts.Contains("context.preference", StringComparison.Ordinal));

            await using var scope = secondFactory.Services.CreateAsyncScope();
            var db = scope.ServiceProvider.GetRequiredService<JarvisDbContext>();
            Assert.Equal(3, await db.RealtimeSessions.CountAsync());
            Assert.Contains(
                await db.RealtimeSessions.Select(session => session.Status).ToListAsync(),
                status => status == Jarvis.Domain.Conversations.RealtimeSessionStatus.Rotated);
        }
        finally
        {
            DeleteDatabase(databasePath);
        }
    }

    private static HttpClient AuthenticatedClient(TestApplicationFactory factory)
    {
        var client = factory.CreateClient();
        client.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", factory.Token);
        return client;
    }

    private static async Task<ConversationResponse> CreateConversationAsync(HttpClient client, string title)
    {
        using var response = await PostAsync(
            client,
            "/api/v1/conversations",
            new CreateConversationRequest(title),
            $"e2e-conversation-{Guid.NewGuid():N}");
        Assert.Equal(HttpStatusCode.Created, response.StatusCode);
        return (await response.Content.ReadFromJsonAsync<ConversationResponse>())!;
    }

    private static async Task<TypedMessageResponse> AddTypedMessageAsync(
        HttpClient client,
        Guid conversationId,
        string clientRequestId,
        string text,
        Guid? realtimeSessionId = null)
    {
        using var response = await PostAsync(
            client,
            $"/api/v1/conversations/{conversationId:D}/messages/typed",
            new TypedMessageRequest(clientRequestId, text, "text", realtimeSessionId),
            $"e2e-typed-{clientRequestId}");
        response.EnsureSuccessStatusCode();
        return (await response.Content.ReadFromJsonAsync<TypedMessageResponse>())!;
    }

    private static async Task<Guid> CreateTaskAsync(
        HttpClient client,
        Guid conversationId,
        string goal,
        bool codex = false)
    {
        var capabilities = codex ? ["localFiles"] : Array.Empty<string>();
        CapabilityEnvelopeContract? envelope = codex
            ? new CapabilityEnvelopeContract(ReadFiles: true, AllowedRoots: [Path.GetTempPath()])
            : null;
        using var response = await PostAsync(
            client,
            "/api/v1/tasks",
            new CreateTaskRequest(
                conversationId,
                [],
                goal,
                "done",
                capabilities,
                CapabilityEnvelope: envelope),
            $"e2e-task-{Guid.NewGuid():N}");
        response.EnsureSuccessStatusCode();
        return (await response.Content.ReadFromJsonAsync<TaskAcceptedResponse>())!.TaskId;
    }

    private static async Task<DesktopDeviceBootstrapResponse> BootstrapDesktopDeviceAsync(HttpClient client)
    {
        using var response = await PostAsync(
            client,
            "/api/v1/realtime/desktop-device",
            new { },
            $"e2e-device-{Guid.NewGuid():N}");
        response.EnsureSuccessStatusCode();
        return (await response.Content.ReadFromJsonAsync<DesktopDeviceBootstrapResponse>())!;
    }

    private static async Task<RealtimeClientSecretResponse> CreateSecretAsync(
        HttpClient client,
        Guid conversationId,
        Guid deviceId,
        string key)
    {
        using var response = await PostAsync(
            client,
            "/api/v1/realtime/client-secrets",
            new RealtimeClientSecretRequest(conversationId, deviceId),
            key);
        response.EnsureSuccessStatusCode();
        return (await response.Content.ReadFromJsonAsync<RealtimeClientSecretResponse>())!;
    }

    private static async Task<DeviceRegistrationResponse> RegisterDeviceAsync(HttpClient client, string name)
    {
        using var response = await PostAsync(
            client,
            "/api/v1/devices/register",
            new DeviceRegistrationRequest(name, DeviceTypeValue.Desktop, "macos", ["localFiles"], [Path.GetTempPath()]),
            $"e2e-register-{Guid.NewGuid():N}");
        Assert.Equal(HttpStatusCode.Created, response.StatusCode);
        return (await response.Content.ReadFromJsonAsync<DeviceRegistrationResponse>())!;
    }

    private static async Task<HttpResponseMessage> PostAsync(
        HttpClient client,
        string path,
        object body,
        string idempotencyKey)
    {
        using var request = new HttpRequestMessage(HttpMethod.Post, path)
        {
            Content = JsonContent.Create(body, options: JsonOptions)
        };
        request.Headers.Add("Idempotency-Key", idempotencyKey);
        return await client.SendAsync(request);
    }

    private static CapabilityPolicy EmptyPolicy() => CapabilityPolicy.Create(new CapabilityEnvelope());

    private static string CreateSecureDirectory(string path)
    {
        var directory = ResolvePhysicalPath(path);
        Directory.CreateDirectory(directory);
        if (!OperatingSystem.IsWindows())
        {
            File.SetUnixFileMode(
                directory,
                UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute);
        }

        return directory;
    }

    private static string ResolvePhysicalPath(string path)
    {
        var fullPath = Path.GetFullPath(path);
        var root = Path.GetPathRoot(fullPath)!;
        var current = root;
        foreach (var segment in fullPath[root.Length..]
                     .Split([Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar], StringSplitOptions.RemoveEmptyEntries))
        {
            var candidate = Path.Combine(current, segment);
            if (!Directory.Exists(candidate) && !File.Exists(candidate))
            {
                current = candidate;
                continue;
            }

            FileSystemInfo info = Directory.Exists(candidate)
                ? new DirectoryInfo(candidate)
                : new FileInfo(candidate);
            current = info.ResolveLinkTarget(returnFinalTarget: true)?.FullName ?? candidate;
        }

        return Path.GetFullPath(current);
    }

    private static void DeleteDatabase(string databasePath)
    {
        foreach (var path in new[] { databasePath, $"{databasePath}-wal", $"{databasePath}-shm" })
        {
            if (File.Exists(path))
            {
                File.Delete(path);
            }
        }
    }

    private sealed class E2EFakeRealtimeClientSecretProvider : IRealtimeClientSecretProvider
    {
        private int callCount;

        public List<ContextPackage> Contexts { get; } = [];

        public Task<RealtimeClientSecretProviderResponse> CreateAsync(
            RealtimeClientSecretProviderRequest request,
            CancellationToken cancellationToken)
        {
            Contexts.Add(request.Context);
            _ = cancellationToken;
            var sequence = Interlocked.Increment(ref callCount);
            return Task.FromResult(new RealtimeClientSecretProviderResponse(
                "ek_e2e_ephemeral",
                DateTimeOffset.UtcNow.AddMinutes(5).ToUnixTimeMilliseconds(),
                $"oai-e2e-session-{sequence}",
                "gpt-4o-realtime-preview",
                "alloy"));
        }
    }

    private sealed class JsonIdentityStore(string path) : IDeviceNodeIdentityStore
    {
        public async Task<DeviceNodeIdentity?> LoadAsync(CancellationToken cancellationToken = default)
        {
            if (!File.Exists(path))
            {
                return null;
            }

            return JsonSerializer.Deserialize<DeviceNodeIdentity>(
                await File.ReadAllTextAsync(path, cancellationToken),
                JsonOptions);
        }

        public async Task SaveAsync(DeviceNodeIdentity identity, CancellationToken cancellationToken = default)
        {
            Directory.CreateDirectory(Path.GetDirectoryName(path)!);
            await File.WriteAllTextAsync(path, JsonSerializer.Serialize(identity, JsonOptions), cancellationToken);
            if (!OperatingSystem.IsWindows())
            {
                File.SetUnixFileMode(path, UnixFileMode.UserRead | UnixFileMode.UserWrite);
            }
        }
    }

    private sealed class ThrowingRegistrationClient : IDeviceNodeRegistrationClient
    {
        public Task<DeviceRegistrationResponse> RegisterAsync(
            DeviceRegistrationRequest request,
            string bootstrapBearer,
            string idempotencyKey,
            CancellationToken cancellationToken) =>
            Task.FromException<DeviceRegistrationResponse>(
                new InvalidOperationException("registration should not be called when identity is persisted"));
    }

    private sealed record PersistedExecution(string ThreadId, Guid ExecutionId);

    private sealed class FailingRuntime(string threadId) : TestRuntime(threadId)
    {
        public override Task<CodexTurnHandle> StartTurnAsync(
            string threadId,
            string input,
            CancellationToken cancellationToken = default) =>
            Task.FromException<CodexTurnHandle>(new EndOfStreamException("device process crashed"));
    }

    private sealed class ResumingRuntime(string threadId) : TestRuntime(threadId)
    {
        public bool ResumeCalled { get; private set; }
        public bool StartCalled { get; private set; }

        public override Task<CodexThreadHandle> StartThreadAsync(
            CapabilityPolicy policy,
            string? cwd,
            CancellationToken cancellationToken = default)
        {
            StartCalled = true;
            return base.StartThreadAsync(policy, cwd, cancellationToken);
        }

        public override Task<CodexThreadHandle> ResumeThreadAsync(
            string threadId,
            CapabilityPolicy policy,
            string? cwd,
            CancellationToken cancellationToken = default)
        {
            ResumeCalled = true;
            return Task.FromResult(new CodexThreadHandle(
                threadId,
                JsonSerializer.SerializeToElement(new { thread = new { id = threadId } })));
        }

        public override Task<CodexTurnHandle> StartTurnAsync(
            string threadId,
            string input,
            CancellationToken cancellationToken = default) =>
            Task.FromResult(new CodexTurnHandle(
                threadId,
                "turn-resumed",
                JsonSerializer.SerializeToElement(new { turn = new { id = "turn-resumed" } })));
    }

    private abstract class TestRuntime(string threadId) : ICodexRuntime
    {
        public Task InitializeAsync(CancellationToken cancellationToken = default) => Task.CompletedTask;

        public virtual Task<CodexThreadHandle> StartThreadAsync(
            CapabilityPolicy policy,
            string? cwd,
            CancellationToken cancellationToken = default) =>
            Task.FromResult(new CodexThreadHandle(
                threadId,
                JsonSerializer.SerializeToElement(new { thread = new { id = threadId } })));

        public virtual Task<CodexThreadHandle> ResumeThreadAsync(
            string threadId,
            CapabilityPolicy policy,
            string? cwd,
            CancellationToken cancellationToken = default) =>
            StartThreadAsync(policy, cwd, cancellationToken);

        public virtual Task<CodexTurnHandle> StartTurnAsync(
            string threadId,
            string input,
            CancellationToken cancellationToken = default) =>
            Task.FromResult(new CodexTurnHandle(
                threadId,
                "turn-test",
                JsonSerializer.SerializeToElement(new { turn = new { id = "turn-test" } })));

        public Task InterruptTurnAsync(string threadId, string turnId, CancellationToken cancellationToken = default) => Task.CompletedTask;

        public async IAsyncEnumerable<CodexRuntimeEvent> ReadEventsAsync(
            [System.Runtime.CompilerServices.EnumeratorCancellation] CancellationToken cancellationToken = default)
        {
            await Task.CompletedTask;
            yield break;
        }

        public Task RespondToServerRequestAsync(
            CodexServerRequest request,
            object result,
            CancellationToken cancellationToken = default) => Task.CompletedTask;

        public string StderrSummary => "test runtime";

        public ValueTask DisposeAsync() => ValueTask.CompletedTask;
    }
}
