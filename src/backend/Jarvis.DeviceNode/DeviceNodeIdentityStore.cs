using System.Diagnostics;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text.Json;
using Jarvis.Contracts;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Options;

namespace Jarvis.DeviceNode;

public sealed record DeviceNodeIdentity(Guid DeviceId, string DeviceCredential);

public interface IDeviceNodeIdentityStore
{
    Task<DeviceNodeIdentity?> LoadAsync(CancellationToken cancellationToken = default);

    Task SaveAsync(DeviceNodeIdentity identity, CancellationToken cancellationToken = default);
}

public interface IDeviceNodeRegistrationClient
{
    Task<DeviceRegistrationResponse> RegisterAsync(
        DeviceRegistrationRequest request,
        string bootstrapBearer,
        string idempotencyKey,
        CancellationToken cancellationToken = default);
}

public sealed class DeviceNodeRegistrationHttpClient(HttpClient client) : IDeviceNodeRegistrationClient
{
    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web);

    public async Task<DeviceRegistrationResponse> RegisterAsync(
        DeviceRegistrationRequest request,
        string bootstrapBearer,
        string idempotencyKey,
        CancellationToken cancellationToken = default)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(bootstrapBearer);
        ArgumentException.ThrowIfNullOrWhiteSpace(idempotencyKey);
        using var message = new HttpRequestMessage(HttpMethod.Post, "/api/v1/devices/register")
        {
            Content = JsonContent.Create(request, options: JsonOptions)
        };
        message.Headers.Authorization = new AuthenticationHeaderValue("Bearer", bootstrapBearer);
        message.Headers.Add("Idempotency-Key", idempotencyKey);
        using var response = await client.SendAsync(
            message,
            HttpCompletionOption.ResponseHeadersRead,
            cancellationToken).ConfigureAwait(false);
        response.EnsureSuccessStatusCode();
        return await response.Content.ReadFromJsonAsync<DeviceRegistrationResponse>(JsonOptions, cancellationToken)
            .ConfigureAwait(false)
            ?? throw new InvalidDataException("Device registration returned an empty response.");
    }
}

public sealed class DeviceNodeBootstrapper(
    IOptions<DeviceNodeOptions> options,
    IDeviceNodeIdentityStore identityStore,
    IDeviceNodeRegistrationClient registrationClient)
{
    private readonly DeviceNodeOptions nodeOptions = options.Value;

    public async Task InitializeAsync(CancellationToken cancellationToken = default)
    {
        var stored = await identityStore.LoadAsync(cancellationToken).ConfigureAwait(false);
        if (stored is not null)
        {
            Apply(stored);
            return;
        }

        if (nodeOptions.DeviceId != Guid.Empty && !string.IsNullOrWhiteSpace(nodeOptions.DeviceCredential))
        {
            var configured = new DeviceNodeIdentity(nodeOptions.DeviceId, nodeOptions.DeviceCredential);
            await identityStore.SaveAsync(configured, cancellationToken).ConfigureAwait(false);
            Apply(configured);
            return;
        }

        if (nodeOptions.DeviceId != Guid.Empty || !string.IsNullOrWhiteSpace(nodeOptions.DeviceCredential))
        {
            throw new InvalidOperationException("DeviceNode identity configuration is incomplete.");
        }

        if (nodeOptions.BootstrapBearer.Length < 32)
        {
            throw new InvalidOperationException(
                "DeviceNode has no stored identity. A one-time DeviceNode:BootstrapBearer is required for pairing.");
        }

        var response = await registrationClient.RegisterAsync(
            new DeviceRegistrationRequest(
                nodeOptions.Name,
                DeviceTypeValue.Desktop,
                nodeOptions.Platform,
                CapabilityNames(nodeOptions.Capabilities),
                nodeOptions.Capabilities.AllowedRoots),
            nodeOptions.BootstrapBearer,
            $"device-pair:{nodeOptions.Name}:{nodeOptions.Platform}:{Guid.NewGuid():N}",
            cancellationToken).ConfigureAwait(false);
        var identity = new DeviceNodeIdentity(response.DeviceId, response.DeviceCredential);
        await identityStore.SaveAsync(identity, cancellationToken).ConfigureAwait(false);
        Apply(identity);
        nodeOptions.BootstrapBearer = string.Empty;
    }

    private void Apply(DeviceNodeIdentity identity)
    {
        if (identity.DeviceId == Guid.Empty || string.IsNullOrWhiteSpace(identity.DeviceCredential))
        {
            throw new InvalidDataException("The stored Device Node identity is invalid.");
        }

        nodeOptions.DeviceId = identity.DeviceId;
        nodeOptions.DeviceCredential = identity.DeviceCredential;
    }

    private static string[] CapabilityNames(CapabilityEnvelopeOptions capabilities)
    {
        var names = new List<string>();
        if (capabilities.ReadFiles) names.Add("localFiles");
        if (capabilities.WriteFiles) names.Add("writeFiles");
        if (capabilities.RunCommands) names.Add("runCommands");
        if (capabilities.Network) names.Add("network");
        return names.ToArray();
    }
}

public sealed class DeviceNodeBootstrapHostedService(DeviceNodeBootstrapper bootstrapper) : IHostedService
{
    public Task StartAsync(CancellationToken cancellationToken) => bootstrapper.InitializeAsync(cancellationToken);

    public Task StopAsync(CancellationToken cancellationToken) => Task.CompletedTask;
}

/// <summary>
/// Persists the Device credential in the current macOS user's login Keychain.
/// The secret is supplied through stdin, never a process argument or log field.
/// </summary>
public sealed class MacOsKeychainDeviceNodeIdentityStore(IOptions<DeviceNodeOptions> options) : IDeviceNodeIdentityStore
{
    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web);
    private readonly DeviceNodeOptions nodeOptions = options.Value;

    public async Task<DeviceNodeIdentity?> LoadAsync(CancellationToken cancellationToken = default)
    {
        EnsureMacOs();
        var result = await RunSecurityAsync(
            ["find-generic-password", "-a", Account(), "-s", Service(), "-w"],
            null,
            cancellationToken).ConfigureAwait(false);
        if (result.ExitCode == 44)
        {
            return null;
        }

        EnsureSuccess(result);
        return JsonSerializer.Deserialize<DeviceNodeIdentity>(result.StandardOutput.Trim(), JsonOptions)
            ?? throw new InvalidDataException("The Keychain Device Node identity is invalid.");
    }

    public async Task SaveAsync(DeviceNodeIdentity identity, CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(identity);
        EnsureMacOs();
        var result = await RunSecurityAsync(
            ["add-generic-password", "-U", "-a", Account(), "-s", Service(), "-w"],
            JsonSerializer.Serialize(identity, JsonOptions),
            cancellationToken).ConfigureAwait(false);
        EnsureSuccess(result);
    }

    private string Account() => string.IsNullOrWhiteSpace(nodeOptions.KeychainAccount)
        ? throw new InvalidOperationException("DeviceNode:KeychainAccount is required.")
        : nodeOptions.KeychainAccount;

    private string Service() => string.IsNullOrWhiteSpace(nodeOptions.KeychainService)
        ? throw new InvalidOperationException("DeviceNode:KeychainService is required.")
        : nodeOptions.KeychainService;

    private static void EnsureMacOs()
    {
        if (!OperatingSystem.IsMacOS())
        {
            throw new PlatformNotSupportedException("V1 Device Node secure identity storage requires macOS Keychain.");
        }
    }

    private static async Task<SecurityResult> RunSecurityAsync(
        IReadOnlyList<string> arguments,
        string? standardInput,
        CancellationToken cancellationToken)
    {
        var startInfo = new ProcessStartInfo
        {
            FileName = "/usr/bin/security",
            UseShellExecute = false,
            RedirectStandardInput = standardInput is not null,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            CreateNoWindow = true
        };
        foreach (var argument in arguments)
        {
            startInfo.ArgumentList.Add(argument);
        }

        using var process = new Process { StartInfo = startInfo };
        if (!process.Start())
        {
            throw new InvalidOperationException("macOS Keychain command could not start.");
        }

        if (standardInput is not null)
        {
            await process.StandardInput.WriteLineAsync(standardInput.AsMemory(), cancellationToken).ConfigureAwait(false);
            process.StandardInput.Close();
        }

        var outputTask = process.StandardOutput.ReadToEndAsync(cancellationToken);
        var errorTask = process.StandardError.ReadToEndAsync(cancellationToken);
        await process.WaitForExitAsync(cancellationToken).ConfigureAwait(false);
        return new SecurityResult(process.ExitCode, await outputTask.ConfigureAwait(false), await errorTask.ConfigureAwait(false));
    }

    private static void EnsureSuccess(SecurityResult result)
    {
        if (result.ExitCode != 0)
        {
            throw new InvalidOperationException(
                $"macOS Keychain operation failed with exit code {result.ExitCode}: {Sanitize(result.StandardError)}");
        }
    }

    private static string Sanitize(string value) => value.Length <= 500 ? value.Trim() : value[..500].Trim();

    private sealed record SecurityResult(int ExitCode, string StandardOutput, string StandardError);
}
