using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text.Json;
using Jarvis.Contracts;
using Jarvis.Infrastructure.Resilience;
using Microsoft.Extensions.Options;

namespace Jarvis.DeviceNode;

public sealed class DeviceNodeOptions
{
    public const string SectionName = "DeviceNode";

    public string ApiBaseUrl { get; set; } = "http://127.0.0.1:5000";
    public Guid DeviceId { get; set; }
    public string DeviceCredential { get; set; } = string.Empty;
    public string BootstrapBearer { get; set; } = string.Empty;
    public string Name { get; set; } = "Jarvis Device Node";
    public string Platform { get; set; } = OperatingSystem.IsMacOS()
        ? "macos"
        : OperatingSystem.IsWindows() ? "windows" : "linux";
    /// <summary>
    /// Optional owner-only identity file used by isolated service smoke tests.
    /// Production macOS installs leave this unset and use the login Keychain.
    /// </summary>
    public string? CredentialFilePath { get; set; }
    public string KeychainService { get; set; } = "com.hobocy.jarvis.device-node";
    public string KeychainAccount { get; set; } = Environment.UserName;
    public CapabilityEnvelopeOptions Capabilities { get; set; } = new();
    public string? WorkingDirectory { get; set; }
    public string CodexBinaryPath { get; set; } = "codex";
    public string[] CodexArguments { get; set; } = ["app-server"];
    public int PollingIntervalMs { get; set; } = 1_000;
    public int HeartbeatIntervalMs { get; set; } = 10_000;
    public int MaxRestartAttempts { get; set; } = 3;
    public int RestartDelayMs { get; set; } = 250;
}

public sealed class CapabilityEnvelopeOptions
{
    public bool ReadFiles { get; set; }
    public bool WriteFiles { get; set; }
    public bool RunCommands { get; set; }
    public bool Network { get; set; }
    public string[] AllowedRoots { get; set; } = [];

    public Jarvis.Application.Devices.CapabilityEnvelope ToEnvelope() => new(
        ReadFiles,
        WriteFiles,
        RunCommands,
        Network,
        AllowedRoots);
}

public interface IDeviceNodeControlPlane
{
    Task<DeviceHeartbeatResponse> HeartbeatAsync(DeviceHeartbeatRequest request, string idempotencyKey, CancellationToken cancellationToken);
    Task<DeviceTaskClaimResponse> ClaimAsync(DeviceTaskClaimRequest request, string idempotencyKey, CancellationToken cancellationToken);
    Task<DeviceActiveTaskListResponse> ListActiveAsync(CancellationToken cancellationToken);
    Task<TaskResponse> GetTaskAsync(Guid taskId, CancellationToken cancellationToken);
    Task<DeviceApprovalStatusResponse> GetApprovalAsync(Guid taskId, Guid approvalId, CancellationToken cancellationToken);
    Task<DeviceTaskLeaseRenewResponse> RenewLeaseAsync(Guid taskId, DeviceTaskLeaseRenewRequest request, string idempotencyKey, CancellationToken cancellationToken);
    Task<DeviceTaskEventResponse> AppendEventAsync(Guid taskId, DeviceTaskEventRequest request, string leaseOwner, string idempotencyKey, CancellationToken cancellationToken);
    Task<DeviceApprovalResponse> CreateApprovalAsync(Guid taskId, DeviceApprovalRequest request, string leaseOwner, string idempotencyKey, CancellationToken cancellationToken);
}

public sealed class DeviceNodeHttpClient(
    HttpClient httpClient,
    IOptions<DeviceNodeOptions> options) : IDeviceNodeControlPlane
{
    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web);
    private readonly DeviceNodeOptions nodeOptions = options.Value;

    public Task<DeviceHeartbeatResponse> HeartbeatAsync(DeviceHeartbeatRequest request, string idempotencyKey, CancellationToken cancellationToken) =>
        SendAsync<DeviceHeartbeatResponse>(HttpMethod.Post, $"/api/v1/devices/{nodeOptions.DeviceId:D}/heartbeat", request, idempotencyKey, null, cancellationToken);

    public Task<DeviceTaskClaimResponse> ClaimAsync(DeviceTaskClaimRequest request, string idempotencyKey, CancellationToken cancellationToken) =>
        SendAsync<DeviceTaskClaimResponse>(HttpMethod.Post, "/api/v1/device-tasks/claim", request, idempotencyKey, null, cancellationToken);

    public Task<DeviceActiveTaskListResponse> ListActiveAsync(CancellationToken cancellationToken) =>
        GetAsync<DeviceActiveTaskListResponse>("/api/v1/device-tasks/active", cancellationToken);

    public Task<TaskResponse> GetTaskAsync(Guid taskId, CancellationToken cancellationToken) =>
        GetAsync<TaskResponse>($"/api/v1/device-tasks/{taskId:D}", cancellationToken);

    public Task<DeviceApprovalStatusResponse> GetApprovalAsync(Guid taskId, Guid approvalId, CancellationToken cancellationToken) =>
        GetAsync<DeviceApprovalStatusResponse>($"/api/v1/device-tasks/{taskId:D}/approvals/{approvalId:D}", cancellationToken);

    public Task<DeviceTaskLeaseRenewResponse> RenewLeaseAsync(Guid taskId, DeviceTaskLeaseRenewRequest request, string idempotencyKey, CancellationToken cancellationToken) =>
        SendAsync<DeviceTaskLeaseRenewResponse>(HttpMethod.Post, $"/api/v1/device-tasks/{taskId:D}/lease:renew", request, idempotencyKey, request.LeaseOwner, cancellationToken);

    public Task<DeviceTaskEventResponse> AppendEventAsync(Guid taskId, DeviceTaskEventRequest request, string leaseOwner, string idempotencyKey, CancellationToken cancellationToken) =>
        SendAsync<DeviceTaskEventResponse>(HttpMethod.Post, $"/api/v1/device-tasks/{taskId:D}/events", request, idempotencyKey, leaseOwner, cancellationToken);

    public Task<DeviceApprovalResponse> CreateApprovalAsync(Guid taskId, DeviceApprovalRequest request, string leaseOwner, string idempotencyKey, CancellationToken cancellationToken) =>
        SendAsync<DeviceApprovalResponse>(HttpMethod.Post, $"/api/v1/device-tasks/{taskId:D}/approvals", request, idempotencyKey, leaseOwner, cancellationToken);

    private async Task<T> SendAsync<T>(
        HttpMethod method,
        string path,
        object body,
        string idempotencyKey,
        string? leaseOwner,
        CancellationToken cancellationToken)
    {
        if (nodeOptions.DeviceId == Guid.Empty || string.IsNullOrWhiteSpace(nodeOptions.DeviceCredential))
        {
            throw new InvalidOperationException("DeviceNode identity is not configured.");
        }

        using var request = new HttpRequestMessage(method, path)
        {
            Content = JsonContent.Create(body, options: JsonOptions)
        };
        request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", nodeOptions.DeviceCredential);
        request.Headers.Add("Idempotency-Key", idempotencyKey);
        request.Options.Set(JarvisHttpResilience.AllowIdempotentRetry, true);
        if (!string.IsNullOrWhiteSpace(leaseOwner))
        {
            request.Headers.Add("X-Lease-Owner", leaseOwner);
        }

        using var response = await httpClient.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, cancellationToken).ConfigureAwait(false);
        if (!response.IsSuccessStatusCode)
        {
            var detail = await response.Content.ReadAsStringAsync(cancellationToken).ConfigureAwait(false);
            throw new DeviceNodeControlPlaneException(response.StatusCode, detail);
        }

        var value = await response.Content.ReadFromJsonAsync<T>(JsonOptions, cancellationToken).ConfigureAwait(false);
        return value ?? throw new InvalidDataException("The Control Plane returned an empty Device Node response.");
    }

    private async Task<T> GetAsync<T>(string path, CancellationToken cancellationToken)
    {
        if (nodeOptions.DeviceId == Guid.Empty || string.IsNullOrWhiteSpace(nodeOptions.DeviceCredential))
        {
            throw new InvalidOperationException("DeviceNode identity is not configured.");
        }

        using var request = new HttpRequestMessage(HttpMethod.Get, path);
        request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", nodeOptions.DeviceCredential);
        using var response = await httpClient.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, cancellationToken).ConfigureAwait(false);
        if (!response.IsSuccessStatusCode)
        {
            var detail = await response.Content.ReadAsStringAsync(cancellationToken).ConfigureAwait(false);
            throw new DeviceNodeControlPlaneException(response.StatusCode, detail);
        }

        return await response.Content.ReadFromJsonAsync<T>(JsonOptions, cancellationToken).ConfigureAwait(false)
            ?? throw new InvalidDataException("The Control Plane returned an empty Device Node response.");
    }
}

public sealed class DeviceNodeControlPlaneException(HttpStatusCode statusCode, string detail) : Exception(
    $"The Device Node Control Plane request failed with {(int)statusCode}: {detail}")
{
    public HttpStatusCode StatusCode { get; } = statusCode;
}
