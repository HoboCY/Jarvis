using Jarvis.DeviceNode;
using Jarvis.DeviceNode.Codex;
using Jarvis.Contracts;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Options;
using System.Diagnostics;
using System.Net;
using System.Net.Http;
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
    public async System.Threading.Tasks.Task ControlPlaneRequestsCarryTheActiveCorrelationId()
    {
        using var activity = new Activity("device-node-test").Start();
        activity!.SetTag("correlation.id", "01JARVIS.TEST-CORRELATION");
        var inner = new RecordingHandler();
        using var handler = new CorrelationIdHttpMessageHandler { InnerHandler = inner };
        using var client = new HttpClient(handler);

        using var response = await client.GetAsync("http://127.0.0.1/health");

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        Assert.Equal("01JARVIS.TEST-CORRELATION", inner.Request!.Headers.GetValues("X-Correlation-ID").Single());
    }

    [Fact]
    public async System.Threading.Tasks.Task CorrelationIdIsGeneratedWhenTheCallHasNoActiveActivity()
    {
        var inner = new RecordingHandler();
        using var handler = new CorrelationIdHttpMessageHandler { InnerHandler = inner };
        using var client = new HttpClient(handler);

        await client.GetAsync("http://127.0.0.1/health");

        var correlationId = inner.Request!.Headers.GetValues("X-Correlation-ID").Single();
        Assert.InRange(correlationId.Length, 20, 128);
        Assert.DoesNotContain("Bearer", correlationId, StringComparison.OrdinalIgnoreCase);
    }

    private sealed class RecordingHandler : HttpMessageHandler
    {
        public HttpRequestMessage? Request { get; private set; }

        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            Request = request;
            return Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK)
            {
                RequestMessage = request
            });
        }
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
    public void UserInputProtocolParsesPinnedParamsAndEmitsOnlyThePinnedResponseEnvelope()
    {
        var requestId = "99";
        var executionId = Guid.NewGuid();
        using var parameters = JsonDocument.Parse("""
            {
              "itemId": "item-user-input",
              "questions": [
                {
                  "header": "Choice",
                  "id": "q1",
                  "question": "Which option?",
                  "isOther": false,
                  "isSecret": false,
                  "options": [
                    { "description": "First option", "label": "A" },
                    { "description": "Second option", "label": "B" }
                  ]
                }
              ],
              "threadId": "thread-user-input",
              "turnId": "turn-user-input",
              "autoResolutionMs": 60000
            }
            """);

        Assert.True(CodexUserInputProtocol.TryParse(
            requestId,
            executionId,
            parameters.RootElement,
            DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
            out var request,
            out var error), error);
        Assert.Equal(executionId, request.ExecutionId);
        Assert.Equal(requestId, request.RequestId);
        Assert.Single(request.Questions);
        Assert.Equal("A", request.Questions[0].Options![0].Label);

        using var response = JsonDocument.Parse(JsonSerializer.Serialize(
            CodexUserInputProtocol.CreateResponse(new Dictionary<string, TaskUserInputAnswer>
            {
                ["q1"] = new(["A"])
            }),
            JsonOptions));
        Assert.Equal(["answers"], response.RootElement.EnumerateObject().Select(property => property.Name));
        var answer = response.RootElement.GetProperty("answers").GetProperty("q1");
        Assert.Equal(["answers"], answer.EnumerateObject().Select(property => property.Name));
        Assert.Equal("A", answer.GetProperty("answers")[0].GetString());

        using var secretParameters = JsonDocument.Parse("""
            {
              "itemId": "item-user-input",
              "questions": [{ "header": "Secret", "id": "q1", "question": "Password?", "isSecret": true }],
              "threadId": "thread-user-input",
              "turnId": "turn-user-input"
            }
            """);
        Assert.False(CodexUserInputProtocol.TryParse(
            requestId,
            executionId,
            secretParameters.RootElement,
            DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
            out _,
            out var secretError));
        Assert.Contains("secret", secretError, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public void TaskPermissionProfileBuildsNativeConfigOverridesForTheEffectivePolicy()
    {
        var root = Path.Combine(Path.GetTempPath(), $"jarvis-profile-root-{Guid.NewGuid():N}");
        Directory.CreateDirectory(root);
        try
        {
            var policy = Jarvis.Application.Devices.CapabilityPolicy.Create(
                new Jarvis.Application.Devices.CapabilityEnvelope(
                    ReadFiles: true,
                    WriteFiles: true,
                    RunCommands: true,
                    Network: true,
                    AllowedRoots: [root]));

            var profile = CodexTaskPermissionProfile.Create(Guid.Parse("11111111-2222-3333-4444-555555555555"), policy);

            Assert.Equal("jarvis-task-11111111222233334444555555555555", profile.Id);
            Assert.Equal(3, profile.CliConfigOverrides.Count);
            Assert.Contains($"default_permissions=\"{profile.Id}\"", profile.CliConfigOverrides);
            Assert.DoesNotContain(profile.CliConfigOverrides, value => value.Contains("permissions.\"", StringComparison.Ordinal));
            Assert.Contains(profile.CliConfigOverrides, value => value.StartsWith($"permissions.{profile.Id}.filesystem=", StringComparison.Ordinal));
            var filesystem = Assert.Single(profile.CliConfigOverrides, value => value.StartsWith($"permissions.{profile.Id}.filesystem=", StringComparison.Ordinal));
            Assert.True(
                filesystem.Contains("\":minimal\"=\"read\"", StringComparison.Ordinal),
                filesystem);
            Assert.DoesNotContain("workspace_roots", filesystem, StringComparison.Ordinal);
            var escapedRoot = root.Replace("\\", "\\\\", StringComparison.Ordinal).Replace("\"", "\\\"", StringComparison.Ordinal);
            Assert.True(
                filesystem.Contains($"\"{escapedRoot}\"=\"write\"", StringComparison.Ordinal),
                filesystem);
            Assert.Contains($"\"{escapedRoot}{Path.DirectorySeparatorChar}.env\"=\"deny\"", filesystem);
            Assert.Contains($"\"{escapedRoot}{Path.DirectorySeparatorChar}**{Path.DirectorySeparatorChar}.env\"=\"deny\"", filesystem);
            Assert.Contains($"permissions.{profile.Id}.network.enabled=true", profile.CliConfigOverrides);
            Assert.True(
                filesystem.Contains("**", StringComparison.Ordinal) && filesystem.Contains(".env", StringComparison.Ordinal)
                    && filesystem.Contains("deny", StringComparison.Ordinal),
                filesystem);
        }
        finally
        {
            Directory.Delete(root, recursive: true);
        }
    }

    [Fact]
    public void TaskPermissionProfileEscapesQuotesAndBackslashesInFilesystemKeys()
    {
        var root = OperatingSystem.IsWindows()
            ? Path.Combine(Path.GetTempPath(), "jarvis-profile-backslash-root")
            : Path.Combine(Path.GetTempPath(), "jarvis-profile-quote\"backslash\\root");
        var policy = Jarvis.Application.Devices.CapabilityPolicy.Create(
            new Jarvis.Application.Devices.CapabilityEnvelope(ReadFiles: true, AllowedRoots: [root]));

        var profile = CodexTaskPermissionProfile.Create(Guid.Parse("22222222-3333-4444-5555-666666666666"), policy);
        var filesystem = Assert.Single(profile.CliConfigOverrides, value => value.StartsWith($"permissions.{profile.Id}.filesystem=", StringComparison.Ordinal));
        var escapedRoot = root.Replace("\\", "\\\\", StringComparison.Ordinal).Replace("\"", "\\\"", StringComparison.Ordinal);

        Assert.Contains($"\"{escapedRoot}\"=\"read\"", filesystem);
        Assert.Contains($"\"{escapedRoot}{Path.DirectorySeparatorChar}.env\"=\"deny\"", filesystem);
        Assert.DoesNotContain($"\"{root}\"=\"read\"", filesystem, StringComparison.Ordinal);
        Assert.Contains($"permissions.{profile.Id}.network.enabled=false", profile.CliConfigOverrides);
    }

    [Fact]
    public void CodexHomeValidationRequiresAnIndependentOwnerOnlyDirectory()
    {
        var root = Directory.CreateTempSubdirectory("jarvis-codex-home-");
        var home = CreateSecureDirectory(Path.Combine(root.FullName, "home"));
        try
        {
            if (!OperatingSystem.IsWindows())
            {
                File.SetUnixFileMode(home, UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute);
            }

            Assert.True(CodexHomeValidator.IsValid(home));
            Assert.False(CodexHomeValidator.IsValid(Path.GetPathRoot(home)));
            Assert.False(CodexHomeValidator.IsValid(Path.Combine(home, "missing")));
            Assert.False(CodexHomeValidator.IsValid(Path.Combine(home, "not-a-directory")));

            var file = Path.Combine(home, "file");
            File.WriteAllText(file, "not a home");
            Assert.False(CodexHomeValidator.IsValid(file));

            if (!OperatingSystem.IsWindows())
            {
                File.SetUnixFileMode(home, UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute | UnixFileMode.GroupRead);
                Assert.False(CodexHomeValidator.IsValid(home));
            }
        }
        finally
        {
            root.Delete(recursive: true);
        }
    }

    [Fact]
    public void CodexHomeValidatorRejectsExistingAncestorSymlinks()
    {
        if (OperatingSystem.IsWindows())
        {
            return;
        }

        var root = Directory.CreateTempSubdirectory("jarvis-codex-home-ancestor-link-");
        var physicalRoot = ResolvePhysicalPath(root.FullName);
        var physicalParent = Directory.CreateDirectory(Path.Combine(physicalRoot, "physical-parent"));
        var linkedParent = Path.Combine(physicalRoot, "linked-parent");
        Directory.CreateSymbolicLink(linkedParent, physicalParent.FullName);
        var linkedHome = Directory.CreateDirectory(Path.Combine(linkedParent, "codex-home")).FullName;
        var simulatedUserHome = Directory.CreateDirectory(Path.Combine(physicalRoot, "simulated-user-home")).FullName;
        try
        {
            File.SetUnixFileMode(linkedHome, UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute);

            Assert.False(CodexHomeValidator.IsValid(linkedHome, simulatedUserHome));
        }
        finally
        {
            root.Delete(recursive: true);
        }
    }

    [Fact]
    public void CodexHomeValidatorRejectsCaseAliasAndDescendantOfUserCodexHomeOnMacOS()
    {
        if (!OperatingSystem.IsMacOS())
        {
            return;
        }

        var root = Directory.CreateTempSubdirectory("jarvis-codex-home-case-alias-");
        var simulatedUserHome = Directory.CreateDirectory(Path.Combine(root.FullName, "simulated-user-home")).FullName;
        var realCodexHome = Directory.CreateDirectory(Path.Combine(simulatedUserHome, ".codex")).FullName;
        try
        {
            var casingAlias = Path.Combine(simulatedUserHome, ".CODEX");
            if (!Directory.Exists(casingAlias))
            {
                return;
            }

            var descendant = Directory.CreateDirectory(Path.Combine(casingAlias, "nested")).FullName;
            File.SetUnixFileMode(realCodexHome, UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute);
            File.SetUnixFileMode(descendant, UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute);

            Assert.False(CodexHomeValidator.IsValid(casingAlias, simulatedUserHome));
            Assert.False(CodexHomeValidator.IsValid(descendant, simulatedUserHome));
        }
        finally
        {
            root.Delete(recursive: true);
        }
    }

    [Fact]
    public async System.Threading.Tasks.Task AppServerUsesTaskProfileAndMinimalEnvironmentWithoutLegacySandboxFields()
    {
        if (OperatingSystem.IsWindows())
        {
            return;
        }

        var root = Directory.CreateTempSubdirectory("jarvis-codex-profile-process-");
        var home = CreateSecureDirectory(Path.Combine(root.FullName, "codex-home"));
        File.SetUnixFileMode(home, UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute);
        var script = Path.Combine(root.FullName, "fake-codex.sh");
        var argsLog = Path.Combine(root.FullName, "args.log");
        var environmentLog = Path.Combine(root.FullName, "environment.log");
        var requestLog = Path.Combine(root.FullName, "requests.log");
        var policy = Jarvis.Application.Devices.CapabilityPolicy.Create(
            new Jarvis.Application.Devices.CapabilityEnvelope(
                ReadFiles: true,
                WriteFiles: true,
                AllowedRoots: [root.FullName]));
        var profile = CodexTaskPermissionProfile.Create(Guid.Parse("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"), policy);
        var shellArgsLog = argsLog.Replace("'", "'\\''", StringComparison.Ordinal);
        var shellEnvironmentLog = environmentLog.Replace("'", "'\\''", StringComparison.Ordinal);
        var shellRequestLog = requestLog.Replace("'", "'\\''", StringComparison.Ordinal);
        var scriptContents = """
#!/bin/sh
set -eu
printf '%s\n' "$@" > '__ARGS__'
if [ -n "${JARVIS_UNSAFE:-}" ]; then exit 91; fi
printf 'PATH=%s\nLANG=%s\nCODEX_HOME=%s\n' "$PATH" "$LANG" "$CODEX_HOME" > '__ENV__'
while IFS= read -r line; do
  printf '%s\n' "$line" >> '__REQ__'
  if echo "$line" | grep -q '"method":"initialize"'; then echo '{"id":1,"result":{}}'; fi
  if echo "$line" | grep -q '"method":"thread/start"'; then echo '{"id":2,"result":{"thread":{"id":"thread-profile"},"activePermissionProfile":{"id":"__PROFILE__"}}}'; fi
  if echo "$line" | grep -q '"method":"thread/resume"'; then echo '{"id":3,"result":{"thread":{"id":"thread-profile"},"activePermissionProfile":{"id":"__PROFILE__"}}}'; fi
  if echo "$line" | grep -q '"method":"turn/start"'; then echo '{"id":4,"result":{"turn":{"id":"turn-profile"}}}'; fi
        done
""";
        scriptContents = scriptContents
            .Replace("__ARGS__", shellArgsLog, StringComparison.Ordinal)
            .Replace("__ENV__", shellEnvironmentLog, StringComparison.Ordinal)
            .Replace("__REQ__", shellRequestLog, StringComparison.Ordinal)
            .Replace("__PROFILE__", profile.Id, StringComparison.Ordinal);
        await File.WriteAllTextAsync(script, scriptContents);
        File.SetUnixFileMode(script, UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute);

        try
        {
            await using (var client = new CodexAppServerClient(new CodexRuntimeOptions(script, ["app-server"])
            {
                Policy = policy,
                CodexHome = home,
                PermissionProfile = profile,
                Environment = new Dictionary<string, string> { ["JARVIS_UNSAFE"] = "must-not-pass" }
            }))
            {
                await client.InitializeAsync();
                var thread = await client.StartThreadAsync(policy, root.FullName);
                var resumed = await client.ResumeThreadAsync(thread.ThreadId, policy, root.FullName);
                var turn = await client.StartTurnAsync(thread.ThreadId, "hello");
                Assert.Equal("thread-profile", thread.ThreadId);
                Assert.Equal("thread-profile", resumed.ThreadId);
                Assert.Equal("turn-profile", turn.TurnId);
            }

            var arguments = await File.ReadAllLinesAsync(argsLog);
            Assert.Contains("app-server", arguments);
            foreach (var overrideValue in profile.CliConfigOverrides)
            {
                Assert.Contains("-c", arguments);
                Assert.Contains(overrideValue, arguments);
            }

            var environmentNames = (await File.ReadAllLinesAsync(environmentLog))
                .Select(line => line.Split('=', 2)[0])
                .ToHashSet(StringComparer.Ordinal);
            Assert.Equal(["CODEX_HOME", "LANG", "PATH"], environmentNames.OrderBy(name => name, StringComparer.Ordinal));
            Assert.Contains($"CODEX_HOME={home}", await File.ReadAllLinesAsync(environmentLog));
            Assert.DoesNotContain("JARVIS_UNSAFE", environmentNames);

            var requests = await File.ReadAllLinesAsync(requestLog);
            var threadRequest = Assert.Single(requests, line => line.Contains("\"method\":\"thread/start\"", StringComparison.Ordinal));
            var resumeRequest = Assert.Single(requests, line => line.Contains("\"method\":\"thread/resume\"", StringComparison.Ordinal));
            var turnRequest = Assert.Single(requests, line => line.Contains("\"method\":\"turn/start\"", StringComparison.Ordinal));
            Assert.DoesNotContain("\"permissions\"", threadRequest);
            Assert.DoesNotContain("\"sandbox\"", threadRequest);
            Assert.DoesNotContain("sandboxPolicy", threadRequest);
            Assert.DoesNotContain("\"permissions\"", resumeRequest);
            Assert.DoesNotContain("\"sandbox\"", resumeRequest);
            Assert.DoesNotContain("sandboxPolicy", resumeRequest);
            Assert.DoesNotContain("sandboxPolicy", turnRequest);
        }
        finally
        {
            root.Delete(recursive: true);
        }
    }

    [Fact]
    public async System.Threading.Tasks.Task AppServerFailsClosedWhenActivePermissionProfileDoesNotMatch()
    {
        if (OperatingSystem.IsWindows())
        {
            return;
        }

        var root = Directory.CreateTempSubdirectory("jarvis-codex-profile-mismatch-");
        var home = CreateSecureDirectory(Path.Combine(root.FullName, "codex-home"));
        File.SetUnixFileMode(home, UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute);
        var script = Path.Combine(root.FullName, "fake-codex.sh");
        await File.WriteAllTextAsync(script, """
#!/bin/sh
while IFS= read -r line; do
  if echo "$line" | grep -q '"method":"initialize"'; then echo '{"id":1,"result":{}}'; fi
  if echo "$line" | grep -q '"method":"thread/start"'; then echo '{"id":2,"result":{"thread":{"id":"thread-mismatch"},"activePermissionProfile":{"id":"wrong-profile"}}}'; fi
done
""");
        File.SetUnixFileMode(script, UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute);
        var policy = Jarvis.Application.Devices.CapabilityPolicy.Create(
            new Jarvis.Application.Devices.CapabilityEnvelope(ReadFiles: true, AllowedRoots: [root.FullName]));
        var profile = CodexTaskPermissionProfile.Create(Guid.Parse("bbbbbbbb-cccc-dddd-eeee-ffffffffffff"), policy);

        try
        {
            await using var client = new CodexAppServerClient(new CodexRuntimeOptions(script, ["app-server"])
            {
                Policy = policy,
                CodexHome = home,
                PermissionProfile = profile
            });
            await client.InitializeAsync();

            await Assert.ThrowsAsync<InvalidDataException>(() => client.StartThreadAsync(policy, root.FullName));
        }
        finally
        {
            root.Delete(recursive: true);
        }
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
    public void DeviceNodeOptionsUseTheLocalApiPortWhenNoEndpointIsConfigured()
    {
        var options = new DeviceNodeOptions();

        Assert.Equal("http://127.0.0.1:5004", options.ApiBaseUrl);
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
    public async System.Threading.Tasks.Task OwnerOnlyIdentityStoreRoundTripsWithOwnerOnlyPermissions()
    {
        var root = Path.Combine(Path.GetTempPath(), $"jarvis-device-identity-{Guid.NewGuid():N}");
        var path = Path.Combine(root, "identity.json");
        var identity = new DeviceNodeIdentity(Guid.NewGuid(), "owner-only-device-credential");
        try
        {
            var options = Options.Create(new DeviceNodeOptions { CredentialFilePath = path });
            var store = new OwnerOnlyFileDeviceNodeIdentityStore(options);

            await store.SaveAsync(identity);

            var loaded = await store.LoadAsync();
            Assert.Equal(identity, loaded);
            if (!OperatingSystem.IsWindows())
            {
                Assert.Equal(UnixFileMode.UserRead | UnixFileMode.UserWrite, File.GetUnixFileMode(path));
            }
        }
        finally
        {
            if (Directory.Exists(root))
            {
                Directory.Delete(root, recursive: true);
            }
        }
    }

    [Fact]
    public async System.Threading.Tasks.Task KeychainIdentityStoreUsesOnlyTheDeviceExecutableAndNeverTheGenericSecurityCli()
    {
        var keychain = new RecordingKeychainApi();
        var options = Options.Create(new DeviceNodeOptions
        {
            KeychainService = "jarvis-test-service",
            KeychainAccount = "jarvis-test-account"
        });
        var store = new MacOsKeychainDeviceNodeIdentityStore(options, keychain, () => "/tmp/Jarvis.DeviceNode");
        var identity = new DeviceNodeIdentity(Guid.NewGuid(), "keychain-device-credential");

        await store.SaveAsync(identity);

        Assert.NotNull(keychain.Access);
        Assert.Equal("/tmp/Jarvis.DeviceNode", keychain.Access!.TrustedApplicationPath);
        Assert.NotEqual("/usr/bin/security", keychain.Access.TrustedApplicationPath);
        Assert.DoesNotContain("/usr/bin/security", keychain.SerializedValue ?? string.Empty, StringComparison.Ordinal);
        Assert.Equal(identity, await store.LoadAsync());
    }

    [Theory]
    [InlineData("/usr/bin/security")]
    [InlineData("/usr/local/bin/dotnet")]
    [InlineData("/tmp/Jarvis.DeviceNode.dll")]
    public async System.Threading.Tasks.Task KeychainIdentityStoreRejectsNonDedicatedTrustedApplications(string processPath)
    {
        var store = new MacOsKeychainDeviceNodeIdentityStore(
            Options.Create(new DeviceNodeOptions
            {
                KeychainService = "jarvis-test-service",
                KeychainAccount = "jarvis-test-account"
            }),
            new RecordingKeychainApi(),
            () => processPath);

        var exception = await Assert.ThrowsAsync<ArgumentException>(() =>
            store.SaveAsync(new DeviceNodeIdentity(Guid.NewGuid(), "keychain-device-credential")));

        Assert.Contains("Keychain", exception.Message, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public async System.Threading.Tasks.Task KeychainIdentityStoreSurfacesNativeErrorsThroughThePublicSeam()
    {
        var store = new MacOsKeychainDeviceNodeIdentityStore(
            Options.Create(new DeviceNodeOptions
            {
                KeychainService = "jarvis-test-service",
                KeychainAccount = "jarvis-test-account"
            }),
            new ThrowingKeychainApi());

        var exception = await Assert.ThrowsAsync<InvalidOperationException>(() => store.LoadAsync());

        Assert.Equal("native keychain failure", exception.Message);
    }

    [Fact]
    public async System.Threading.Tasks.Task KeychainIdentityStoreHonorsCallerCancellationBeforeNativeOperations()
    {
        var keychain = new RecordingKeychainApi();
        var store = new MacOsKeychainDeviceNodeIdentityStore(
            Options.Create(new DeviceNodeOptions
            {
                KeychainService = "jarvis-test-service",
                KeychainAccount = "jarvis-test-account"
            }),
            keychain);
        using var cancellation = new CancellationTokenSource();
        cancellation.Cancel();

        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => store.LoadAsync(cancellation.Token));
        Assert.Equal(0, keychain.ReadCount);
    }

    [Fact]
    public void SecurityFrameworkKeychainCapturesAndRestoresTrueAndFalseInteractionStatesWithoutRealUi()
    {
        foreach (var previousState in new byte[] { 0, 1 })
        {
            var native = new RecordingKeychainNative { InteractionState = previousState };
            var keychain = new SecurityFrameworkKeychainApi(native);

            Assert.Null(keychain.ReadGenericPassword("service", "account"));
            Assert.Equal(new byte[] { 0, previousState }, native.StateChanges);
            Assert.Equal(1, native.ReadCount);
        }
    }

    [Fact]
    public void SecurityFrameworkKeychainFailsClosedWhenInteractionStateCannotBeRead()
    {
        var native = new RecordingKeychainNative { GetStatus = -50 };
        var keychain = new SecurityFrameworkKeychainApi(native);

        var exception = Assert.Throws<InvalidOperationException>(() => keychain.ReadGenericPassword("service", "account"));

        Assert.Contains("get user interaction", exception.Message, StringComparison.OrdinalIgnoreCase);
        Assert.Empty(native.StateChanges);
        Assert.Equal(0, native.ReadCount);
    }

    [Fact]
    public void SecurityFrameworkKeychainFailsClosedWhenInteractionStateCannotBeDisabled()
    {
        var native = new RecordingKeychainNative { InteractionState = 1 };
        native.SetStatuses.Enqueue(-51);
        var keychain = new SecurityFrameworkKeychainApi(native);

        var exception = Assert.Throws<InvalidOperationException>(() => keychain.ReadGenericPassword("service", "account"));

        Assert.Contains("disable user interaction", exception.Message, StringComparison.OrdinalIgnoreCase);
        Assert.Equal(new byte[] { 0, 1 }, native.StateChanges);
        Assert.Equal(0, native.ReadCount);
    }

    [Fact]
    public void SecurityFrameworkKeychainRestoresInteractionAfterBusinessFailure()
    {
        var native = new RecordingKeychainNative { InteractionState = 1, ReadException = new InvalidOperationException("business failure") };
        var keychain = new SecurityFrameworkKeychainApi(native);

        var exception = Assert.Throws<InvalidOperationException>(() => keychain.ReadGenericPassword("service", "account"));

        Assert.Equal("business failure", exception.Message);
        Assert.Equal(new byte[] { 0, 1 }, native.StateChanges);
    }

    [Fact]
    public void SecurityFrameworkKeychainSurfacesInteractionRestoreFailure()
    {
        var native = new RecordingKeychainNative { InteractionState = 1 };
        native.SetStatuses.Enqueue(0);
        native.SetStatuses.Enqueue(-52);
        var keychain = new SecurityFrameworkKeychainApi(native);

        var exception = Assert.Throws<InvalidOperationException>(() => keychain.ReadGenericPassword("service", "account"));

        Assert.Contains("restore user interaction", exception.Message, StringComparison.OrdinalIgnoreCase);
        Assert.Equal(new byte[] { 0, 1 }, native.StateChanges);
    }

    [Fact]
    public async System.Threading.Tasks.Task FakeJsonlProcessCompletesInitializeThreadTurnAndInterrupt()
    {
        var script = Path.Combine(Path.GetTempPath(), $"jarvis-fake-codex-{Guid.NewGuid():N}.sh");
        var policy = Jarvis.Application.Devices.CapabilityPolicy.Create(new Jarvis.Application.Devices.CapabilityEnvelope());
        var profile = CodexTaskPermissionProfile.Create(Guid.Parse("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"), policy);
        var home = CreateSecureDirectory(Path.Combine(Path.GetTempPath(), $"jarvis-codex-home-{Guid.NewGuid():N}"));
        await File.WriteAllTextAsync(script, "#!/bin/sh\nwhile IFS= read -r line; do\n  if echo \"$line\" | grep -q '\"method\":\"initialize\"'; then echo '{\"id\":1,\"result\":{}}'; fi\n  if echo \"$line\" | grep -q '\"method\":\"thread/start\"'; then echo '{\"id\":2,\"result\":{\"thread\":{\"id\":\"thread-fake\"},\"activePermissionProfile\":{\"id\":\"jarvis-task-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\"}}}'; fi\n  if echo \"$line\" | grep -q '\"method\":\"turn/start\"'; then echo '{\"id\":3,\"result\":{\"turn\":{\"id\":\"turn-fake\"}}}'; echo '{\"method\":\"item/agentMessage/delta\",\"params\":{\"delta\":\"hello\"}}'; echo '{\"id\":99,\"method\":\"item/fileChange/requestApproval\",\"params\":{\"itemId\":\"item-1\",\"threadId\":\"thread-fake\",\"turnId\":\"turn-fake\",\"startedAtMs\":1}}'; fi\n  if echo \"$line\" | grep -q '\"method\":\"turn/interrupt\"'; then echo '{\"id\":4,\"result\":{}}'; fi\ndone\n");
        if (!OperatingSystem.IsWindows())
        {
            File.SetUnixFileMode(script, UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute);
        }

        try
        {
            await using var client = new CodexAppServerClient(new CodexRuntimeOptions(script, [])
            {
                Policy = policy,
                CodexHome = home,
                PermissionProfile = profile
            });
            await client.InitializeAsync();
            var thread = await client.StartThreadAsync(policy, null);
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
            Directory.Delete(home, recursive: true);
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
        await File.WriteAllTextAsync(script, "#!/bin/sh\nprofile_id=\"\"\nfor argument in \"$@\"; do\n  case \"$argument\" in\n    default_permissions=*) profile_id=$(echo \"$argument\" | sed 's/^default_permissions=\"//; s/\"$//');;\n  esac\ndone\nwhile IFS= read -r line; do\n  if echo \"$line\" | grep -q '\"method\":\"initialize\"'; then echo '{\"id\":1,\"result\":{}}'; fi\n  if echo \"$line\" | grep -q '\"method\":\"thread/start\"'; then printf '{\"id\":2,\"result\":{\"thread\":{\"id\":\"thread-approved\"},\"activePermissionProfile\":{\"id\":\"%s\"}}}\\n' \"$profile_id\"; fi\n  if echo \"$line\" | grep -q '\"method\":\"turn/start\"'; then echo '{\"id\":3,\"result\":{\"turn\":{\"id\":\"turn-approved\"}}}'; echo '{\"id\":99,\"method\":\"item/commandExecution/requestApproval\",\"params\":{\"command\":\"pwd\",\"reason\":\"bounded command\"}}'; fi\n  if echo \"$line\" | grep -q '\"id\":99,\"result\":{\"decision\":\"acceptForSession\"'; then echo '{\"method\":\"turn/completed\",\"params\":{\"status\":\"completed\",\"summary\":\"approved completion\",\"artifacts\":[]}}'; fi\ndone\n");
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
                CodexHome = CreateSecureDirectory(Path.Combine(root.FullName, "codex-home")),
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
    public async System.Threading.Tasks.Task FakeJsonlUserInputBridgeAnswersTheOriginalRequestAndCompletesTheSameTurn()
    {
        var root = Directory.CreateTempSubdirectory("jarvis-fake-codex-user-input-");
        var script = Path.Combine(root.FullName, "fake-codex.sh");
        var requestsPath = Path.Combine(root.FullName, "requests.jsonl");
        var scriptContents = """
            #!/bin/sh
            profile_id=""
            for argument in "$@"; do
              case "$argument" in
                default_permissions=*) profile_id=$(echo "$argument" | sed 's/^default_permissions="//; s/"$//');;
              esac
            done
            while IFS= read -r line; do
              echo "$line" >> '__REQUESTS_PATH__'
              if echo "$line" | grep -q '"method":"initialize"'; then echo '{"id":1,"result":{}}'; fi
              if echo "$line" | grep -q '"method":"thread/start"'; then printf '{"id":2,"result":{"thread":{"id":"thread-input"},"activePermissionProfile":{"id":"%s"}}}\n' "$profile_id"; fi
              if echo "$line" | grep -q '"method":"turn/start"'; then echo '{"id":3,"result":{"turn":{"id":"turn-input"}}}'; echo '{"id":"001","method":"item/tool/requestUserInput","params":{"itemId":"item-input","questions":[{"header":"Choice","id":"q1","question":"Choose one","options":[{"description":"The first option","label":"A"},{"description":"The second option","label":"B"}]}],"threadId":"thread-input","turnId":"turn-input","autoResolutionMs":60000}}'; fi
              if echo "$line" | grep -q '"id":"001","result":{"answers":{"q1":{"answers":'; then echo '{"id":99,"method":"item/tool/requestUserInput","params":{"itemId":"item-input-number","questions":[{"header":"Choice","id":"q1","question":"Choose one","options":[{"description":"The first option","label":"A"},{"description":"The second option","label":"B"}]}],"threadId":"thread-input","turnId":"turn-input","autoResolutionMs":60000}}'; fi
              if echo "$line" | grep -q '"id":99,"result":{"answers":{"q1":{"answers":'; then echo '{"method":"turn/completed","params":{"status":"completed","summary":"input completion","artifacts":[]}}'; fi
            done
            """;
        scriptContents = scriptContents.Replace("__REQUESTS_PATH__", requestsPath, StringComparison.Ordinal);
        await File.WriteAllTextAsync(script, scriptContents);
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
                "ask for one bounded choice",
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
                "input-owner",
                30_000,
                new CapabilityEnvelopeContract(ReadFiles: true, AllowedRoots: [taskRoot]));
            var controlPlane = new RecordingControlPlane
            {
                UserInputAnswerAfterPolls = 1,
                UserInputAnswers = new Dictionary<string, TaskUserInputAnswer>
                {
                    ["q1"] = new(["A"])
                }
            };
            var options = Options.Create(new DeviceNodeOptions
            {
                CodexBinaryPath = script,
                CodexArguments = [],
                CodexHome = CreateSecureDirectory(Path.Combine(root.FullName, "codex-home")),
                HeartbeatIntervalMs = 30_000,
                PollingIntervalMs = 25,
                MaxRestartAttempts = 0,
                Capabilities = new CapabilityEnvelopeOptions
                {
                    ReadFiles = true,
                    AllowedRoots = [root.FullName]
                }
            });
            var worker = new DeviceNodeWorker(
                options,
                controlPlane,
                NullLogger<DeviceNodeWorker>.Instance,
                timeProvider: TimeProvider.System,
                userInputWaiter: new PollingUserInputWaiter(controlPlane, options, TimeProvider.System));

            await worker.ExecuteClaimAsync(
                claim,
                Jarvis.Application.Devices.CapabilityPolicy.Create(options.Value.Capabilities.ToEnvelope()),
                new CancellationTokenSource(TimeSpan.FromSeconds(5)).Token);

            var completed = Assert.Single(controlPlane.Events, item => item.EventType == "task.completed");
            Assert.Equal("input completion", completed.ResultSummary);
            Assert.True(controlPlane.UserInputPollCount > 0);
            var responseLines = (await File.ReadAllLinesAsync(requestsPath))
                .Select(line => JsonDocument.Parse(line).RootElement.Clone())
                .Where(item => item.TryGetProperty("result", out _))
                .ToArray();
            var stringResponse = Assert.Single(responseLines, item =>
                item.TryGetProperty("id", out var id)
                && id.ValueKind == JsonValueKind.String
                && id.GetString() == "001");
            var numericResponse = Assert.Single(responseLines, item =>
                item.TryGetProperty("id", out var id)
                && id.ValueKind == JsonValueKind.Number
                && id.GetInt32() == 99);
            foreach (var responseLine in new[] { stringResponse, numericResponse })
            {
                Assert.Equal(["id", "result"], responseLine.EnumerateObject().Select(property => property.Name));
                var result = responseLine.GetProperty("result");
                Assert.Equal(["answers"], result.EnumerateObject().Select(property => property.Name));
                var questionAnswer = result.GetProperty("answers").GetProperty("q1");
                Assert.Equal(["answers"], questionAnswer.EnumerateObject().Select(property => property.Name));
                Assert.Equal("A", questionAnswer.GetProperty("answers")[0].GetString());
            }
        }
        finally
        {
            root.Delete(recursive: true);
        }
    }

    [Fact]
    public async System.Threading.Tasks.Task FakeJsonlResolvedUserInputFailsClosedWithoutSendingAnAnswer()
    {
        var root = Directory.CreateTempSubdirectory("jarvis-fake-codex-user-input-resolved-");
        var script = Path.Combine(root.FullName, "fake-codex.sh");
        var requestsPath = Path.Combine(root.FullName, "requests.jsonl");
        var scriptContents = """
            #!/bin/sh
            profile_id=""
            for argument in "$@"; do
              case "$argument" in
                default_permissions=*) profile_id=$(echo "$argument" | sed 's/^default_permissions="//; s/"$//');;
              esac
            done
            while IFS= read -r line; do
              echo "$line" >> '__REQUESTS_PATH__'
              if echo "$line" | grep -q '"method":"initialize"'; then echo '{"id":1,"result":{}}'; fi
              if echo "$line" | grep -q '"method":"thread/start"'; then printf '{"id":2,"result":{"thread":{"id":"thread-resolved"},"activePermissionProfile":{"id":"%s"}}}\n' "$profile_id"; fi
              if echo "$line" | grep -q '"method":"turn/start"'; then echo '{"id":3,"result":{"turn":{"id":"turn-resolved"}}}'; echo '{"id":99,"method":"item/tool/requestUserInput","params":{"itemId":"item-resolved","questions":[{"header":"Choice","id":"q1","question":"Choose one"}],"threadId":"thread-resolved","turnId":"turn-resolved"}}'; echo '{"method":"serverRequest/resolved","params":{"threadId":"thread-resolved","requestId":99}}'; fi
            done
            """.Replace("__REQUESTS_PATH__", requestsPath, StringComparison.Ordinal);
        await File.WriteAllTextAsync(script, scriptContents);
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
                "fail closed after Codex resolves input",
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
                "resolved-owner",
                30_000,
                new CapabilityEnvelopeContract(ReadFiles: true, AllowedRoots: [taskRoot]));
            var controlPlane = new RecordingControlPlane
            {
                UserInputAnswerAfterPolls = 1,
                UserInputAnswers = new Dictionary<string, TaskUserInputAnswer>
                {
                    ["q1"] = new(["A"])
                }
            };
            var options = Options.Create(new DeviceNodeOptions
            {
                CodexBinaryPath = script,
                CodexArguments = [],
                CodexHome = CreateSecureDirectory(Path.Combine(root.FullName, "codex-home")),
                HeartbeatIntervalMs = 30_000,
                PollingIntervalMs = 25,
                MaxRestartAttempts = 0,
                Capabilities = new CapabilityEnvelopeOptions
                {
                    ReadFiles = true,
                    AllowedRoots = [root.FullName]
                }
            });
            var worker = new DeviceNodeWorker(
                options,
                controlPlane,
                NullLogger<DeviceNodeWorker>.Instance,
                timeProvider: TimeProvider.System,
                userInputWaiter: new PollingUserInputWaiter(controlPlane, options, TimeProvider.System));

            await worker.ExecuteClaimAsync(
                claim,
                Jarvis.Application.Devices.CapabilityPolicy.Create(options.Value.Capabilities.ToEnvelope()),
                new CancellationTokenSource(TimeSpan.FromSeconds(5)).Token);

            Assert.Equal(TaskUserInputStatusValue.Cleared, controlPlane.UserInputResponse?.Status);
            var responseLines = (await File.ReadAllLinesAsync(requestsPath))
                .Select(line => JsonDocument.Parse(line).RootElement.Clone())
                .Where(item => item.TryGetProperty("result", out _))
                .ToArray();
            Assert.DoesNotContain(responseLines, item =>
                item.TryGetProperty("id", out var id)
                && id.ValueKind == JsonValueKind.Number
                && id.GetInt32() == 99);
        }
        finally
        {
            root.Delete(recursive: true);
        }
    }

    [Fact]
    public async System.Threading.Tasks.Task FakeJsonlCancellationWinsTheInputRaceWithoutSendingAnAnswer()
    {
        var root = Directory.CreateTempSubdirectory("jarvis-fake-codex-user-input-cancel-");
        var script = Path.Combine(root.FullName, "fake-codex.sh");
        var requestsPath = Path.Combine(root.FullName, "requests.jsonl");
        var scriptContents = """
            #!/bin/sh
            profile_id=""
            for argument in "$@"; do
              case "$argument" in
                default_permissions=*) profile_id=$(echo "$argument" | sed 's/^default_permissions="//; s/"$//');;
              esac
            done
            while IFS= read -r line; do
              echo "$line" >> '__REQUESTS_PATH__'
              if echo "$line" | grep -q '"method":"initialize"'; then echo '{"id":1,"result":{}}'; fi
              if echo "$line" | grep -q '"method":"thread/start"'; then printf '{"id":2,"result":{"thread":{"id":"thread-cancel"},"activePermissionProfile":{"id":"%s"}}}\n' "$profile_id"; fi
              if echo "$line" | grep -q '"method":"turn/start"'; then echo '{"id":3,"result":{"turn":{"id":"turn-cancel"}}}'; echo '{"id":99,"method":"item/tool/requestUserInput","params":{"itemId":"item-cancel","questions":[{"header":"Choice","id":"q1","question":"Choose one"}],"threadId":"thread-cancel","turnId":"turn-cancel"}}'; fi
              if echo "$line" | grep -q '"method":"turn/interrupt"'; then echo '{"id":4,"result":{}}'; fi
            done
            """.Replace("__REQUESTS_PATH__", requestsPath, StringComparison.Ordinal);
        await File.WriteAllTextAsync(script, scriptContents);
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
                "cancel after Codex asks for input",
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
                "cancel-owner",
                30_000,
                new CapabilityEnvelopeContract(ReadFiles: true, AllowedRoots: [taskRoot]));
            var controlPlane = new RecordingControlPlane
            {
                CancelUserInputAfterPolls = 1
            };
            var options = Options.Create(new DeviceNodeOptions
            {
                CodexBinaryPath = script,
                CodexArguments = [],
                CodexHome = CreateSecureDirectory(Path.Combine(root.FullName, "codex-home")),
                HeartbeatIntervalMs = 30_000,
                PollingIntervalMs = 25,
                MaxRestartAttempts = 0,
                Capabilities = new CapabilityEnvelopeOptions
                {
                    ReadFiles = true,
                    AllowedRoots = [root.FullName]
                }
            });
            var worker = new DeviceNodeWorker(
                options,
                controlPlane,
                NullLogger<DeviceNodeWorker>.Instance,
                timeProvider: TimeProvider.System,
                userInputWaiter: new PollingUserInputWaiter(controlPlane, options, TimeProvider.System));

            await worker.ExecuteClaimAsync(
                claim,
                Jarvis.Application.Devices.CapabilityPolicy.Create(options.Value.Capabilities.ToEnvelope()),
                new CancellationTokenSource(TimeSpan.FromSeconds(5)).Token);

            Assert.True(controlPlane.CancellationRequested);
            Assert.Contains(controlPlane.Events, item => item.EventType == "task.cancelled");
            var responseLines = (await File.ReadAllLinesAsync(requestsPath))
                .Select(line => JsonDocument.Parse(line).RootElement.Clone())
                .Where(item => item.TryGetProperty("result", out _))
                .ToArray();
            Assert.DoesNotContain(responseLines, item =>
                item.TryGetProperty("id", out var id)
                && id.ValueKind == JsonValueKind.Number
                && id.GetInt32() == 99);
        }
        finally
        {
            root.Delete(recursive: true);
        }
    }

    [Fact]
    public async System.Threading.Tasks.Task FakeJsonlLeaseLossWinsTheInputRaceWithoutSendingAnAnswer()
    {
        var root = Directory.CreateTempSubdirectory("jarvis-fake-codex-user-input-lease-loss-");
        var script = Path.Combine(root.FullName, "fake-codex.sh");
        var requestsPath = Path.Combine(root.FullName, "requests.jsonl");
        var scriptContents = """
            #!/bin/sh
            profile_id=""
            for argument in "$@"; do
              case "$argument" in
                default_permissions=*) profile_id=$(echo "$argument" | sed 's/^default_permissions="//; s/"$//');;
              esac
            done
            while IFS= read -r line; do
              echo "$line" >> '__REQUESTS_PATH__'
              if echo "$line" | grep -q '"method":"initialize"'; then echo '{"id":1,"result":{}}'; fi
              if echo "$line" | grep -q '"method":"thread/start"'; then printf '{"id":2,"result":{"thread":{"id":"thread-lease-loss"},"activePermissionProfile":{"id":"%s"}}}\n' "$profile_id"; fi
              if echo "$line" | grep -q '"method":"turn/start"'; then echo '{"id":3,"result":{"turn":{"id":"turn-lease-loss"}}}'; echo '{"id":99,"method":"item/tool/requestUserInput","params":{"itemId":"item-lease-loss","questions":[{"header":"Choice","id":"q1","question":"Choose one"}],"threadId":"thread-lease-loss","turnId":"turn-lease-loss"}}'; fi
            done
            """.Replace("__REQUESTS_PATH__", requestsPath, StringComparison.Ordinal);
        await File.WriteAllTextAsync(script, scriptContents);
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
                "fail closed after a lease loss",
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
                "lease-loss-owner",
                30_000,
                new CapabilityEnvelopeContract(ReadFiles: true, AllowedRoots: [taskRoot]));
            var controlPlane = new RecordingControlPlane
            {
                FailLeaseRenewal = true
            };
            var options = Options.Create(new DeviceNodeOptions
            {
                CodexBinaryPath = script,
                CodexArguments = [],
                CodexHome = CreateSecureDirectory(Path.Combine(root.FullName, "codex-home")),
                HeartbeatIntervalMs = 750,
                PollingIntervalMs = 25,
                MaxRestartAttempts = 0,
                Capabilities = new CapabilityEnvelopeOptions
                {
                    ReadFiles = true,
                    AllowedRoots = [root.FullName]
                }
            });
            var worker = new DeviceNodeWorker(
                options,
                controlPlane,
                NullLogger<DeviceNodeWorker>.Instance,
                timeProvider: TimeProvider.System,
                userInputWaiter: new PollingUserInputWaiter(controlPlane, options, TimeProvider.System));

            await worker.ExecuteClaimAsync(
                claim,
                Jarvis.Application.Devices.CapabilityPolicy.Create(options.Value.Capabilities.ToEnvelope()),
                new CancellationTokenSource(TimeSpan.FromSeconds(5)).Token);

            Assert.Contains(controlPlane.Events, item => item.EventType == "task.failed");
            var responseLines = (await File.ReadAllLinesAsync(requestsPath))
                .Select(line => JsonDocument.Parse(line).RootElement.Clone())
                .Where(item => item.TryGetProperty("result", out _))
                .ToArray();
            Assert.DoesNotContain(responseLines, item =>
                item.TryGetProperty("id", out var id)
                && id.ValueKind == JsonValueKind.Number
                && id.GetInt32() == 99);
        }
        finally
        {
            root.Delete(recursive: true);
        }
    }

    [Fact]
    public async System.Threading.Tasks.Task ExecuteClaimFailsClosedWhenTaskCapabilityEnvelopeIsMissing()
    {
        var root = Directory.CreateTempSubdirectory("jarvis-missing-capability-envelope-");
        var marker = Path.Combine(root.FullName, "codex-started");
        var script = Path.Combine(root.FullName, "should-not-start.sh");
        var taskRoot = Directory.CreateDirectory(Path.Combine(root.FullName, "task-root")).FullName;
        await File.WriteAllTextAsync(script, $"#!/bin/sh\ntouch '{marker}'\nexit 99\n");
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
                "must fail closed without a capability envelope",
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
                "missing-envelope-owner",
                30_000);
            var controlPlane = new RecordingControlPlane();
            var options = Options.Create(new DeviceNodeOptions
            {
                CodexBinaryPath = script,
                CodexArguments = [],
                CodexHome = CreateSecureDirectory(Path.Combine(root.FullName, "codex-home")),
                MaxRestartAttempts = 0,
                Capabilities = new CapabilityEnvelopeOptions
                {
                    ReadFiles = true,
                    Network = true,
                    AllowedRoots = [root.FullName]
                }
            });
            var worker = new DeviceNodeWorker(options, controlPlane, NullLogger<DeviceNodeWorker>.Instance);

            await worker.ExecuteClaimAsync(
                claim,
                Jarvis.Application.Devices.CapabilityPolicy.Create(options.Value.Capabilities.ToEnvelope()),
                new CancellationTokenSource(TimeSpan.FromSeconds(5)).Token);

            Assert.False(File.Exists(marker));
            var failed = Assert.Single(controlPlane.Events, item => item.EventType == "task.failed");
            Assert.Equal("capability_envelope_missing", failed.ErrorCode);
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
        var scriptContents = """
#!/bin/sh
profile_id=""
for argument in "$@"; do
  case "$argument" in
    default_permissions=*) profile_id=$(echo "$argument" | sed 's/^default_permissions="//; s/"$//');;
  esac
done
if [ ! -f '__MARKER__' ]; then touch '__MARKER__'; first=1; else first=0; fi
while IFS= read -r line; do
  if echo "$line" | grep -q '"method":"initialize"'; then echo '{"id":1,"result":{}}'; fi
  if [ "$first" = 1 ] && echo "$line" | grep -q '"method":"thread/start"'; then printf '{"id":2,"result":{"thread":{"id":"thread-recovered"},"activePermissionProfile":{"id":"%s"}}}\n' "$profile_id"; fi
  if [ "$first" = 1 ] && echo "$line" | grep -q '"method":"turn/start"'; then echo '{"id":3,"result":{"turn":{"id":"turn-recovered"}}}'; exit 17; fi
  if [ "$first" = 0 ] && echo "$line" | grep -q '"method":"thread/resume"'; then printf '{"id":2,"result":{"thread":{"id":"thread-recovered"},"activePermissionProfile":{"id":"%s"}}}\n' "$profile_id"; echo '{"method":"turn/completed","params":{"turn":{"id":"turn-recovered","status":"completed"},"summary":"recovered completion","artifacts":[]}}'; fi
  if [ "$first" = 0 ] && echo "$line" | grep -q '"method":"turn/start"'; then touch '__REPLAY_MARKER__'; exit 18; fi
done
""";
        scriptContents = scriptContents
            .Replace("__MARKER__", marker, StringComparison.Ordinal)
            .Replace("__REPLAY_MARKER__", replayMarker, StringComparison.Ordinal);
        await File.WriteAllTextAsync(script, scriptContents);
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
                CodexHome = CreateSecureDirectory(Path.Combine(root.FullName, "codex-home")),
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
        var scriptContents = """
#!/bin/sh
profile_id=""
for argument in "$@"; do
  case "$argument" in
    default_permissions=*) profile_id=$(echo "$argument" | sed 's/^default_permissions="//; s/"$//');;
  esac
done
while IFS= read -r line; do
  if echo "$line" | grep -q '"method":"initialize"'; then echo '{"id":1,"result":{}}'; fi
  if echo "$line" | grep -q '"method":"thread/resume"'; then printf '{"id":2,"result":{"thread":{"id":"thread-uncertain"},"activePermissionProfile":{"id":"%s"}}}\n' "$profile_id"; fi
  if echo "$line" | grep -q '"method":"turn/start"'; then touch '__REPLAY_MARKER__'; exit 19; fi
done
""";
        scriptContents = scriptContents.Replace("__REPLAY_MARKER__", replayMarker, StringComparison.Ordinal);
        await File.WriteAllTextAsync(script, scriptContents);
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
                CodexHome = CreateSecureDirectory(Path.Combine(root.FullName, "codex-home")),
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

    private static string CreateSecureDirectory(string path)
    {
        var physicalPath = ResolvePhysicalPath(path);
        Directory.CreateDirectory(physicalPath);
        if (!OperatingSystem.IsWindows())
        {
            File.SetUnixFileMode(physicalPath, UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute);
        }

        return physicalPath;
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
        public int UserInputAnswerAfterPolls { get; set; }
        public int UserInputPollCount { get; private set; }
        public int CancelUserInputAfterPolls { get; set; }
        public bool FailLeaseRenewal { get; set; }
        public bool CancellationRequested { get; private set; }
        public IReadOnlyDictionary<string, TaskUserInputAnswer>? UserInputAnswers { get; set; }
        public DeviceTaskUserInputResponse? UserInputResponse { get; private set; }

        public System.Threading.Tasks.Task<DeviceHeartbeatResponse> HeartbeatAsync(DeviceHeartbeatRequest request, string idempotencyKey, CancellationToken cancellationToken) =>
            System.Threading.Tasks.Task.FromResult(new DeviceHeartbeatResponse(Guid.NewGuid(), DeviceStatusValue.Online, 0, request.Capabilities ?? [], 1));

        public System.Threading.Tasks.Task<DeviceTaskClaimResponse> ClaimAsync(DeviceTaskClaimRequest request, string idempotencyKey, CancellationToken cancellationToken) =>
            System.Threading.Tasks.Task.FromResult(new DeviceTaskClaimResponse(false, null, null, null, null));

        public System.Threading.Tasks.Task<DeviceActiveTaskListResponse> ListActiveAsync(CancellationToken cancellationToken) =>
            System.Threading.Tasks.Task.FromResult(new DeviceActiveTaskListResponse([]));

        public System.Threading.Tasks.Task<TaskResponse> GetTaskAsync(Guid taskId, CancellationToken cancellationToken)
        {
            var pending = UserInputResponse is null
                ? null
                : new TaskUserInputResponse(
                    UserInputResponse.RequestId,
                    UserInputResponse.ItemId,
                    UserInputResponse.ThreadId,
                    UserInputResponse.TurnId,
                    UserInputResponse.Questions,
                    TaskUserInputStatusValue.Pending,
                    UserInputResponse.ExpiresAtMs,
                    UserInputResponse.RequestIdIsString);
            return System.Threading.Tasks.Task.FromResult(new TaskResponse(
                taskId,
                Guid.NewGuid(),
                null,
                "goal",
                null,
                [],
                [],
                null,
                null,
                WorkerKindValue.Codex,
                pending is null ? TaskStatusValue.Running : TaskStatusValue.WaitingForUserInput,
                0,
                1,
                null,
                null,
                null,
                null,
                null,
                1,
                0,
                0,
                null,
                null,
                null,
                null,
                pending) with
            {
                Status = CancellationRequested ? TaskStatusValue.CancellationRequested : (pending is null ? TaskStatusValue.Running : TaskStatusValue.WaitingForUserInput)
            });
        }

        public System.Threading.Tasks.Task<DeviceApprovalStatusResponse> GetApprovalAsync(Guid taskId, Guid approvalId, CancellationToken cancellationToken)
        {
            ApprovalPollCount++;
            var status = ApprovalStatuses.Count > 1 ? ApprovalStatuses.Dequeue() : ApprovalStatuses.Peek();
            return System.Threading.Tasks.Task.FromResult(new DeviceApprovalStatusResponse(approvalId, taskId, Guid.NewGuid(), Guid.NewGuid(), status, status == ApprovalStatusValue.Approved ? ApprovalDecisionValue.Approve : null, null));
        }

        public System.Threading.Tasks.Task<DeviceTaskLeaseRenewResponse> RenewLeaseAsync(Guid taskId, DeviceTaskLeaseRenewRequest request, string idempotencyKey, CancellationToken cancellationToken) =>
            System.Threading.Tasks.Task.FromResult(new DeviceTaskLeaseRenewResponse(taskId, !FailLeaseRenewal, 1, TaskStatusValue.Running));

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

        public System.Threading.Tasks.Task<DeviceTaskUserInputResponse> CreateUserInputAsync(Guid taskId, DeviceTaskUserInputRequest request, string leaseOwner, string idempotencyKey, CancellationToken cancellationToken)
        {
            if (UserInputResponse is null
                || !string.Equals(UserInputResponse.RequestId, request.RequestId, StringComparison.Ordinal)
                || UserInputResponse.RequestIdIsString != request.RequestIdIsString)
            {
                UserInputResponse = new DeviceTaskUserInputResponse(
                    taskId,
                    request.ExecutionId,
                    request.RequestId,
                    request.ItemId,
                    request.ThreadId,
                    request.TurnId,
                    request.Questions,
                    TaskUserInputStatusValue.Pending,
                    null,
                    request.AutoResolutionMs,
                    request.RequestIdIsString);
            }

            return System.Threading.Tasks.Task.FromResult(UserInputResponse);
        }

        public System.Threading.Tasks.Task<DeviceTaskUserInputResponse> GetUserInputAsync(Guid taskId, Guid executionId, string requestId, bool requestIdIsString, string leaseOwner, CancellationToken cancellationToken)
        {
            UserInputPollCount++;
            if (CancelUserInputAfterPolls > 0 && UserInputPollCount >= CancelUserInputAfterPolls)
            {
                CancellationRequested = true;
            }

            if (UserInputResponse is not null
                && UserInputResponse.Status == TaskUserInputStatusValue.Pending
                && UserInputAnswerAfterPolls > 0
                && UserInputPollCount >= UserInputAnswerAfterPolls)
            {
                UserInputResponse = UserInputResponse with
                {
                    Status = TaskUserInputStatusValue.Answered,
                    Answers = UserInputAnswers
                };
            }

            if (CancellationRequested && UserInputResponse is not null)
            {
                return System.Threading.Tasks.Task.FromResult(UserInputResponse with { Status = TaskUserInputStatusValue.Cleared, Answers = null });
            }

            return System.Threading.Tasks.Task.FromResult(UserInputResponse ?? new DeviceTaskUserInputResponse(
                taskId,
                executionId,
                requestId,
                "item",
                "thread",
                "turn",
                [],
                TaskUserInputStatusValue.Pending));
        }

        public System.Threading.Tasks.Task<DeviceTaskUserInputResponse> ResolveUserInputAsync(Guid taskId, Guid executionId, string requestId, bool requestIdIsString, string leaseOwner, string idempotencyKey, CancellationToken cancellationToken)
        {
            UserInputResponse = UserInputResponse is null
                ? new DeviceTaskUserInputResponse(taskId, executionId, requestId, "item", "thread", "turn", [], TaskUserInputStatusValue.Cleared, null, null, requestIdIsString)
                : UserInputResponse with { Status = TaskUserInputStatusValue.Cleared, Answers = null };
            return System.Threading.Tasks.Task.FromResult(UserInputResponse);
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

    private sealed class RecordingKeychainApi : IMacOsKeychainApi
    {
        public MacOsKeychainAccess? Access { get; private set; }
        public string? SerializedValue { get; private set; }
        public int ReadCount { get; private set; }

        public string? ReadGenericPassword(string service, string account)
        {
            ReadCount++;
            return SerializedValue;
        }

        public void WriteGenericPassword(string service, string account, string password, MacOsKeychainAccess access)
        {
            SerializedValue = password;
            Access = access;
        }
    }

    private sealed class ThrowingKeychainApi : IMacOsKeychainApi
    {
        public string? ReadGenericPassword(string service, string account) =>
            throw new InvalidOperationException("native keychain failure");

        public void WriteGenericPassword(string service, string account, string password, MacOsKeychainAccess access) =>
            throw new InvalidOperationException("native keychain failure");
    }

    private sealed class RecordingKeychainNative : IMacOsKeychainNative
    {
        public byte InteractionState { get; set; } = 1;
        public int GetStatus { get; set; }
        public Queue<int> SetStatuses { get; } = new();
        public List<byte> StateChanges { get; } = [];
        public Exception? ReadException { get; set; }
        public int ReadCount { get; private set; }

        public int GetUserInteractionAllowed(out byte state)
        {
            state = InteractionState;
            return GetStatus;
        }

        public int SetUserInteractionAllowed(byte state)
        {
            StateChanges.Add(state);
            var status = SetStatuses.Count > 0 ? SetStatuses.Dequeue() : 0;
            if (status == 0)
            {
                InteractionState = state;
            }

            return status;
        }

        public string? ReadGenericPassword(string service, string account)
        {
            ReadCount++;
            if (ReadException is not null)
            {
                throw ReadException;
            }

            return null;
        }

        public void WriteGenericPassword(string service, string account, string password, MacOsKeychainAccess access)
        {
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
