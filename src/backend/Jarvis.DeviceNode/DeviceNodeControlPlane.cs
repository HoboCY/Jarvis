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

    public string ApiBaseUrl { get; set; } = "http://127.0.0.1:5004";
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
    public string CodexHome { get; set; } = string.Empty;
    public string CodexBinaryPath { get; set; } = "codex";
    public string[] CodexArguments { get; set; } = ["app-server"];
    public int PollingIntervalMs { get; set; } = 1_000;
    public int HeartbeatIntervalMs { get; set; } = 10_000;
    public int MaxRestartAttempts { get; set; } = 3;
    public int RestartDelayMs { get; set; } = 250;
}

public static class CodexHomeValidator
{
    public static bool IsValid(string? path) => TryValidate(
        path,
        Environment.GetFolderPath(Environment.SpecialFolder.UserProfile),
        out _);

    internal static bool IsValid(string? path, string? userHome) => TryValidate(path, userHome, out _);

    public static void Validate(string? path)
    {
        if (!TryValidate(path, Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), out var error))
        {
            throw new InvalidOperationException(error);
        }
    }

    private static bool TryValidate(string? path, string? userHome, out string error)
    {
        error = "DeviceNode:CodexHome must be an existing absolute directory other than the filesystem root.";
        if (string.IsNullOrWhiteSpace(path) || !Path.IsPathFullyQualified(path))
        {
            return false;
        }

        string fullPath;
        try
        {
            fullPath = Path.GetFullPath(path);
        }
        catch (ArgumentException)
        {
            return false;
        }
        catch (NotSupportedException)
        {
            return false;
        }

        var root = Path.GetPathRoot(fullPath);
        var comparison = OperatingSystem.IsWindows() || OperatingSystem.IsMacOS()
            ? StringComparison.OrdinalIgnoreCase
            : StringComparison.Ordinal;
        if (root is null || string.Equals(fullPath, root, comparison))
        {
            return false;
        }

        try
        {
            if (string.IsNullOrWhiteSpace(userHome) || !Path.IsPathFullyQualified(userHome))
            {
                return false;
            }

            var userHomePath = Path.GetFullPath(userHome);
            var userCodexHome = Path.Combine(userHomePath, ".codex");
            if (IsSameOrDescendant(fullPath, userCodexHome, comparison))
            {
                error = "DeviceNode:CodexHome must be an independent directory, not the user's ~/.codex.";
                return false;
            }

            if (ContainsExistingSymlink(fullPath))
            {
                error = "DeviceNode:CodexHome must not contain a symbolic-link ancestor.";
                return false;
            }

            if (!Directory.Exists(fullPath))
            {
                return false;
            }

            var physicalUserHome = ResolveExistingPath(userHomePath);
            var physicalCandidate = ResolveExistingPath(fullPath);
            var physicalUserCodexHome = ResolveExistingPath(Path.Combine(physicalUserHome, ".codex"));
            if (IsSameOrDescendant(physicalCandidate, physicalUserCodexHome, comparison))
            {
                error = "DeviceNode:CodexHome must not alias the user's ~/.codex.";
                return false;
            }

            if (!OperatingSystem.IsWindows())
            {
                const UnixFileMode groupOrOther = UnixFileMode.GroupRead
                    | UnixFileMode.GroupWrite
                    | UnixFileMode.GroupExecute
                    | UnixFileMode.OtherRead
                    | UnixFileMode.OtherWrite
                    | UnixFileMode.OtherExecute;
                const UnixFileMode ownerAccess = UnixFileMode.UserRead
                    | UnixFileMode.UserWrite
                    | UnixFileMode.UserExecute;
                var mode = File.GetUnixFileMode(fullPath);
                if ((mode & groupOrOther) != 0)
                {
                    error = "DeviceNode:CodexHome must reject group/other permissions on Unix (use mode 0700).";
                    return false;
                }

                if ((mode & ownerAccess) != ownerAccess)
                {
                    error = "DeviceNode:CodexHome must be owner-readable, writable, and executable on Unix.";
                    return false;
                }
            }

            return true;
        }
        catch (IOException)
        {
            return false;
        }
        catch (UnauthorizedAccessException)
        {
            return false;
        }
        catch (ArgumentException)
        {
            return false;
        }
        catch (NotSupportedException)
        {
            return false;
        }
    }

    private static bool ContainsExistingSymlink(string fullPath)
    {
        var root = Path.GetPathRoot(fullPath)
            ?? throw new ArgumentException("CodexHome must have a filesystem root.", nameof(fullPath));
        var segments = fullPath[root.Length..]
            .Split([Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar], StringSplitOptions.RemoveEmptyEntries);
        var current = root;
        for (var index = 0; index < segments.Length; index++)
        {
            current = Path.Combine(current, segments[index]);
            try
            {
                var attributes = File.GetAttributes(current);
                if ((attributes & FileAttributes.ReparsePoint) != 0)
                {
                    return true;
                }
            }
            catch (FileNotFoundException)
            {
                break;
            }
            catch (DirectoryNotFoundException)
            {
                break;
            }

            FileSystemInfo info = Directory.Exists(current)
                ? new DirectoryInfo(current)
                : new FileInfo(current);
            if (info.ResolveLinkTarget(returnFinalTarget: true) is not null)
            {
                return true;
            }
        }

        return false;
    }

    private static string ResolveExistingPath(string fullPath)
    {
        var root = Path.GetPathRoot(fullPath)
            ?? throw new ArgumentException("CodexHome must have a filesystem root.", nameof(fullPath));
        var current = root;
        var segments = fullPath[root.Length..]
            .Split([Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar], StringSplitOptions.RemoveEmptyEntries);
        for (var index = 0; index < segments.Length; index++)
        {
            var candidate = Path.Combine(current, segments[index]);
            if (!Directory.Exists(candidate) && !File.Exists(candidate))
            {
                current = Path.Combine(current, string.Join(Path.DirectorySeparatorChar, segments[index..]));
                break;
            }

            FileSystemInfo info = Directory.Exists(candidate)
                ? new DirectoryInfo(candidate)
                : new FileInfo(candidate);
            current = info.ResolveLinkTarget(returnFinalTarget: true)?.FullName ?? candidate;
        }

        return TrimTrailingSeparators(Path.GetFullPath(current));
    }

    private static bool IsSameOrDescendant(string path, string basePath, StringComparison comparison)
    {
        var normalizedPath = TrimTrailingSeparators(Path.GetFullPath(path));
        var normalizedBase = TrimTrailingSeparators(Path.GetFullPath(basePath));
        if (comparison == StringComparison.OrdinalIgnoreCase)
        {
            normalizedPath = normalizedPath.ToUpperInvariant();
            normalizedBase = normalizedBase.ToUpperInvariant();
        }

        if (string.Equals(normalizedPath, normalizedBase, comparison))
        {
            return true;
        }

        return normalizedPath.StartsWith(
            normalizedBase + Path.DirectorySeparatorChar,
            comparison);
    }

    private static string TrimTrailingSeparators(string path)
    {
        var root = Path.GetPathRoot(path);
        return string.Equals(path, root, OperatingSystem.IsWindows() || OperatingSystem.IsMacOS()
                ? StringComparison.OrdinalIgnoreCase
                : StringComparison.Ordinal)
            ? path
            : path.TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
    }
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
    Task<DeviceTaskUserInputResponse> CreateUserInputAsync(Guid taskId, DeviceTaskUserInputRequest request, string leaseOwner, string idempotencyKey, CancellationToken cancellationToken);
    Task<DeviceTaskUserInputResponse> GetUserInputAsync(Guid taskId, Guid executionId, string requestId, bool requestIdIsString, string leaseOwner, CancellationToken cancellationToken);
    Task<DeviceTaskUserInputResponse> ResolveUserInputAsync(Guid taskId, Guid executionId, string requestId, bool requestIdIsString, string leaseOwner, string idempotencyKey, CancellationToken cancellationToken);
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

    public Task<DeviceTaskUserInputResponse> CreateUserInputAsync(Guid taskId, DeviceTaskUserInputRequest request, string leaseOwner, string idempotencyKey, CancellationToken cancellationToken) =>
        SendAsync<DeviceTaskUserInputResponse>(HttpMethod.Post, $"/api/v1/device-tasks/{taskId:D}/user-input", request, idempotencyKey, leaseOwner, cancellationToken);

    public Task<DeviceTaskUserInputResponse> GetUserInputAsync(Guid taskId, Guid executionId, string requestId, bool requestIdIsString, string leaseOwner, CancellationToken cancellationToken) =>
        GetAsync<DeviceTaskUserInputResponse>($"/api/v1/device-tasks/{taskId:D}/user-input/{Uri.EscapeDataString(requestId)}?executionId={executionId:D}&requestIdIsString={requestIdIsString.ToString().ToLowerInvariant()}", leaseOwner, cancellationToken);

    public Task<DeviceTaskUserInputResponse> ResolveUserInputAsync(Guid taskId, Guid executionId, string requestId, bool requestIdIsString, string leaseOwner, string idempotencyKey, CancellationToken cancellationToken) =>
        SendAsync<DeviceTaskUserInputResponse>(HttpMethod.Post, $"/api/v1/device-tasks/{taskId:D}/user-input/{Uri.EscapeDataString(requestId)}/resolved?executionId={executionId:D}&requestIdIsString={requestIdIsString.ToString().ToLowerInvariant()}", new { }, idempotencyKey, leaseOwner, cancellationToken);

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

    private Task<T> GetAsync<T>(string path, CancellationToken cancellationToken) => GetAsync<T>(path, null, cancellationToken);

    private async Task<T> GetAsync<T>(string path, string? leaseOwner, CancellationToken cancellationToken)
    {
        if (nodeOptions.DeviceId == Guid.Empty || string.IsNullOrWhiteSpace(nodeOptions.DeviceCredential))
        {
            throw new InvalidOperationException("DeviceNode identity is not configured.");
        }

        using var request = new HttpRequestMessage(HttpMethod.Get, path);
        request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", nodeOptions.DeviceCredential);
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

        return await response.Content.ReadFromJsonAsync<T>(JsonOptions, cancellationToken).ConfigureAwait(false)
            ?? throw new InvalidDataException("The Control Plane returned an empty Device Node response.");
    }
}

public sealed class DeviceNodeControlPlaneException(HttpStatusCode statusCode, string detail) : Exception(
    $"The Device Node Control Plane request failed with {(int)statusCode}: {detail}")
{
    public HttpStatusCode StatusCode { get; } = statusCode;
}
