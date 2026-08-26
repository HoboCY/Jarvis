using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Runtime.InteropServices;
using System.Text.Json;
using Jarvis.Contracts;
using Jarvis.Infrastructure.Resilience;
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
        message.Options.Set(JarvisHttpResilience.AllowIdempotentRetry, true);
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
/// Identifies the one executable allowed to read a Keychain item.
/// </summary>
public sealed record MacOsKeychainAccess
{
    public MacOsKeychainAccess(string trustedApplicationPath)
    {
        if (string.IsNullOrWhiteSpace(trustedApplicationPath) || !Path.IsPathFullyQualified(trustedApplicationPath))
        {
            throw new ArgumentException("A fully-qualified trusted application path is required.", nameof(trustedApplicationPath));
        }

        var normalizedPath = Path.GetFullPath(trustedApplicationPath);
        if (string.Equals(normalizedPath, "/usr/bin/security", StringComparison.Ordinal))
        {
            throw new ArgumentException("The generic macOS security CLI cannot be a Keychain trusted application.", nameof(trustedApplicationPath));
        }

        var executableName = Path.GetFileName(normalizedPath);
        if (string.Equals(executableName, "dotnet", StringComparison.OrdinalIgnoreCase)
            || string.Equals(executableName, "dotnet.exe", StringComparison.OrdinalIgnoreCase))
        {
            throw new ArgumentException(
                "The shared dotnet host cannot be a Keychain trusted application; publish and run the dedicated self-contained Jarvis.DeviceNode apphost.",
                nameof(trustedApplicationPath));
        }

        if (!string.Equals(executableName, "Jarvis.DeviceNode", StringComparison.Ordinal))
        {
            throw new ArgumentException(
                "The Keychain trusted application must be the dedicated self-contained Jarvis.DeviceNode apphost.",
                nameof(trustedApplicationPath));
        }

        TrustedApplicationPath = normalizedPath;
    }

    public string TrustedApplicationPath { get; }
}

/// <summary>
/// Small public seam around the macOS Security.framework APIs. The production
/// registration supplies the native implementation; tests can inject a
/// synchronous fake without invoking a Keychain prompt or a shell command.
/// </summary>
public interface IMacOsKeychainApi
{
    string? ReadGenericPassword(string service, string account);

    void WriteGenericPassword(string service, string account, string password, MacOsKeychainAccess access);
}

/// <summary>
/// Synchronous Security.framework seam. The interaction-state methods mirror
/// the native OSStatus/out-Boolean ABI so tests can exercise fail-closed state
/// capture and restoration without invoking a real Keychain or UI.
/// </summary>
internal interface IMacOsKeychainNative
{
    int GetUserInteractionAllowed(out byte state);

    int SetUserInteractionAllowed(byte state);

    string? ReadGenericPassword(string service, string account);

    void WriteGenericPassword(string service, string account, string password, MacOsKeychainAccess access);
}

/// <summary>
/// Persists the Device credential in the current macOS user's login Keychain.
/// Security.framework applies an ACL for the Device Node executable itself;
/// no generic <c>/usr/bin/security</c> process is granted access.
/// </summary>
public sealed class MacOsKeychainDeviceNodeIdentityStore : IDeviceNodeIdentityStore
{
    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web);
    private readonly DeviceNodeOptions nodeOptions;
    private readonly IMacOsKeychainApi keychainApi;
    private readonly Func<string?> processPathProvider;
    private readonly bool requireMacOs;

    public MacOsKeychainDeviceNodeIdentityStore(IOptions<DeviceNodeOptions> options)
        : this(options, new SecurityFrameworkKeychainApi(), static () => Environment.ProcessPath, requireMacOs: true)
    {
    }

    public MacOsKeychainDeviceNodeIdentityStore(IOptions<DeviceNodeOptions> options, IMacOsKeychainApi keychainApi)
        : this(options, keychainApi, static () => Environment.ProcessPath, requireMacOs: false)
    {
    }

    public MacOsKeychainDeviceNodeIdentityStore(
        IOptions<DeviceNodeOptions> options,
        IMacOsKeychainApi keychainApi,
        Func<string?> processPathProvider)
        : this(options, keychainApi, processPathProvider, requireMacOs: false)
    {
    }

    private MacOsKeychainDeviceNodeIdentityStore(
        IOptions<DeviceNodeOptions> options,
        IMacOsKeychainApi keychainApi,
        Func<string?> processPathProvider,
        bool requireMacOs)
    {
        ArgumentNullException.ThrowIfNull(options);
        ArgumentNullException.ThrowIfNull(keychainApi);
        ArgumentNullException.ThrowIfNull(processPathProvider);
        nodeOptions = options.Value;
        this.keychainApi = keychainApi;
        this.processPathProvider = processPathProvider;
        this.requireMacOs = requireMacOs;
    }

    public Task<DeviceNodeIdentity?> LoadAsync(CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        EnsureMacOs();
        var serialized = keychainApi.ReadGenericPassword(Service(), Account());
        cancellationToken.ThrowIfCancellationRequested();
        if (serialized is null)
        {
            return Task.FromResult<DeviceNodeIdentity?>(null);
        }

        var identity = JsonSerializer.Deserialize<DeviceNodeIdentity>(serialized, JsonOptions)
            ?? throw new InvalidDataException("The Keychain Device Node identity is invalid.");
        return Task.FromResult<DeviceNodeIdentity?>(identity);
    }

    public Task SaveAsync(DeviceNodeIdentity identity, CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(identity);
        cancellationToken.ThrowIfCancellationRequested();
        EnsureMacOs();
        var executable = processPathProvider();
        if (string.IsNullOrWhiteSpace(executable))
        {
            throw new InvalidOperationException("The Device Node executable path is unavailable for Keychain ACL setup.");
        }

        var access = new MacOsKeychainAccess(executable);
        var serialized = JsonSerializer.Serialize(identity, JsonOptions);
        keychainApi.WriteGenericPassword(Service(), Account(), serialized, access);
        cancellationToken.ThrowIfCancellationRequested();
        return Task.CompletedTask;
    }

    private string Account() => string.IsNullOrWhiteSpace(nodeOptions.KeychainAccount)
        ? throw new InvalidOperationException("DeviceNode:KeychainAccount is required.")
        : nodeOptions.KeychainAccount;

    private string Service() => string.IsNullOrWhiteSpace(nodeOptions.KeychainService)
        ? throw new InvalidOperationException("DeviceNode:KeychainService is required.")
        : nodeOptions.KeychainService;

    private void EnsureMacOs()
    {
        if (requireMacOs && !OperatingSystem.IsMacOS())
        {
            throw new PlatformNotSupportedException("V1 Device Node secure identity storage requires macOS Keychain.");
        }
    }

}

/// <summary>
/// Native Security.framework implementation. Keeping this behind
/// <see cref="IMacOsKeychainApi"/> makes ACL behavior observable in tests while
/// ensuring the production path never invokes the interactive security CLI.
/// </summary>
internal sealed class SecurityFrameworkKeychainApi : IMacOsKeychainApi
{
    private const int ErrSecSuccess = 0;
    private const int ErrSecItemNotFound = -25300;
    private const int ErrSecInteractionNotAllowed = -25308;
    private const string SecurityFramework = "/System/Library/Frameworks/Security.framework/Security";
    private const string CoreFoundation = "/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation";
    private static readonly object UserInteractionGate = new();
    private readonly IMacOsKeychainNative native;

    public SecurityFrameworkKeychainApi()
        : this(new SecurityFrameworkKeychainNative())
    {
    }

    internal SecurityFrameworkKeychainApi(IMacOsKeychainNative native)
    {
        ArgumentNullException.ThrowIfNull(native);
        this.native = native;
    }

    public string? ReadGenericPassword(string service, string account) =>
        WithoutUserInteraction(() => native.ReadGenericPassword(service, account));

    public void WriteGenericPassword(string service, string account, string password, MacOsKeychainAccess access) =>
        WithoutUserInteraction(() => native.WriteGenericPassword(service, account, password, access));

    private static string? ReadGenericPasswordNative(string service, string account)
    {
        using var serviceBytes = new UnmanagedUtf8(service);
        using var accountBytes = new UnmanagedUtf8(account);
        var status = SecKeychainFindGenericPassword(
            IntPtr.Zero,
            checked((uint)serviceBytes.Length),
            serviceBytes.Pointer,
            checked((uint)accountBytes.Length),
            accountBytes.Pointer,
            out var passwordLength,
            out var passwordData,
            out var itemRef);
        if (status == ErrSecItemNotFound)
        {
            return null;
        }

        EnsureStatus(status, "find generic password");
        try
        {
            var bytes = new byte[passwordLength];
            if (passwordLength > 0)
            {
                Marshal.Copy(passwordData, bytes, 0, checked((int)passwordLength));
            }

            return System.Text.Encoding.UTF8.GetString(bytes);
        }
        finally
        {
            if (passwordData != IntPtr.Zero)
            {
                EnsureStatus(SecKeychainItemFreeContent(IntPtr.Zero, passwordData), "free generic password content");
            }

            if (itemRef != IntPtr.Zero)
            {
                CFRelease(itemRef);
            }
        }
    }

    private static void WriteGenericPasswordNative(string service, string account, string password, MacOsKeychainAccess access)
    {
        ArgumentNullException.ThrowIfNull(access);
        using var serviceBytes = new UnmanagedUtf8(service);
        using var accountBytes = new UnmanagedUtf8(account);
        using var passwordBytes = new UnmanagedUtf8(password);
        var status = SecKeychainFindGenericPassword(
            IntPtr.Zero,
            checked((uint)serviceBytes.Length),
            serviceBytes.Pointer,
            checked((uint)accountBytes.Length),
            accountBytes.Pointer,
            out _,
            out var existingPasswordData,
            out var itemRef);

        if (existingPasswordData != IntPtr.Zero)
        {
            EnsureStatus(SecKeychainItemFreeContent(IntPtr.Zero, existingPasswordData), "free generic password content");
        }

        if (status == ErrSecItemNotFound)
        {
            EnsureStatus(
                SecKeychainAddGenericPassword(
                    IntPtr.Zero,
                    checked((uint)serviceBytes.Length),
                    serviceBytes.Pointer,
                    checked((uint)accountBytes.Length),
                    accountBytes.Pointer,
                    checked((uint)passwordBytes.Length),
                    passwordBytes.Pointer,
                    out itemRef),
                "add generic password");
        }
        else
        {
            EnsureStatus(status, "find generic password for update");
            EnsureStatus(
                SecKeychainItemModifyAttributesAndData(
                    itemRef,
                    IntPtr.Zero,
                    checked((uint)passwordBytes.Length),
                    passwordBytes.Pointer),
                "update generic password");
        }

        try
        {
            SetAccess(itemRef, access);
        }
        finally
        {
            if (itemRef != IntPtr.Zero)
            {
                CFRelease(itemRef);
            }
        }
    }

    private T WithoutUserInteraction<T>(Func<T> operation)
    {
        lock (UserInteractionGate)
        {
            var getStatus = native.GetUserInteractionAllowed(out var previousState);
            EnsureStatus(getStatus, "get user interaction setting");

            var disableStatus = native.SetUserInteractionAllowed(0);
            if (disableStatus != ErrSecSuccess)
            {
                var restoreAfterDisableFailureStatus = native.SetUserInteractionAllowed(previousState);
                if (restoreAfterDisableFailureStatus != ErrSecSuccess)
                {
                    throw new InvalidOperationException(
                        $"macOS Keychain disable user interaction failed with status {disableStatus}; "
                        + $"restoring the previous setting also failed with status {restoreAfterDisableFailureStatus}.");
                }

                EnsureStatus(disableStatus, "disable user interaction");
            }

            try
            {
                return operation();
            }
            finally
            {
                EnsureStatus(native.SetUserInteractionAllowed(previousState), "restore user interaction setting");
            }
        }
    }

    private void WithoutUserInteraction(Action operation) =>
        WithoutUserInteraction(
            () =>
            {
                operation();
                return true;
            });

    private static void SetAccess(IntPtr itemRef, MacOsKeychainAccess access)
    {
        using var executablePath = new UnmanagedUtf8(access.TrustedApplicationPath);
        EnsureStatus(
            SecTrustedApplicationCreateFromPath(executablePath.Pointer, out var trustedApplication),
            "create trusted application");
        try
        {
            var trustedApplications = CFArrayCreateMutable(IntPtr.Zero, 1, IntPtr.Zero);
            if (trustedApplications == IntPtr.Zero)
            {
                throw new InvalidOperationException("macOS Keychain trusted application list could not be created.");
            }

            try
            {
                CFArrayAppendValue(trustedApplications, trustedApplication);
                EnsureStatus(
                    SecAccessCreate(IntPtr.Zero, trustedApplications, out var keychainAccess),
                    "create Keychain access");
                try
                {
                    EnsureStatus(SecKeychainItemSetAccess(itemRef, keychainAccess), "set Keychain access");
                }
                finally
                {
                    if (keychainAccess != IntPtr.Zero)
                    {
                        CFRelease(keychainAccess);
                    }
                }
            }
            finally
            {
                CFRelease(trustedApplications);
            }
        }
        finally
        {
            if (trustedApplication != IntPtr.Zero)
            {
                CFRelease(trustedApplication);
            }
        }
    }

    private static void EnsureStatus(int status, string operation)
    {
        if (status != ErrSecSuccess)
        {
            if (status == ErrSecInteractionNotAllowed)
            {
                throw new InvalidOperationException(
                    $"macOS Keychain {operation} refused user interaction ({status}); the Device Node fails closed without showing UI.");
            }

            throw new InvalidOperationException($"macOS Keychain {operation} failed with status {status}.");
        }
    }

    private sealed class SecurityFrameworkKeychainNative : IMacOsKeychainNative
    {
        public int GetUserInteractionAllowed(out byte state) => SecKeychainGetUserInteractionAllowed(out state);

        public int SetUserInteractionAllowed(byte state) => SecKeychainSetUserInteractionAllowed(state);

        public string? ReadGenericPassword(string service, string account) => ReadGenericPasswordNative(service, account);

        public void WriteGenericPassword(string service, string account, string password, MacOsKeychainAccess access) =>
            WriteGenericPasswordNative(service, account, password, access);
    }

    [DllImport(SecurityFramework, EntryPoint = "SecKeychainFindGenericPassword")]
    private static extern int SecKeychainFindGenericPassword(
        IntPtr keychainOrArray,
        uint serviceNameLength,
        IntPtr serviceName,
        uint accountNameLength,
        IntPtr accountName,
        out uint passwordLength,
        out IntPtr passwordData,
        out IntPtr itemRef);

    [DllImport(SecurityFramework, EntryPoint = "SecKeychainAddGenericPassword")]
    private static extern int SecKeychainAddGenericPassword(
        IntPtr keychain,
        uint serviceNameLength,
        IntPtr serviceName,
        uint accountNameLength,
        IntPtr accountName,
        uint passwordLength,
        IntPtr passwordData,
        out IntPtr itemRef);

    [DllImport(SecurityFramework, EntryPoint = "SecKeychainItemModifyAttributesAndData")]
    private static extern int SecKeychainItemModifyAttributesAndData(
        IntPtr itemRef,
        IntPtr attrList,
        uint length,
        IntPtr data);

    [DllImport(SecurityFramework, EntryPoint = "SecKeychainItemFreeContent")]
    private static extern int SecKeychainItemFreeContent(IntPtr attrList, IntPtr data);

    [DllImport(SecurityFramework, EntryPoint = "SecKeychainItemSetAccess")]
    private static extern int SecKeychainItemSetAccess(IntPtr itemRef, IntPtr access);

    [DllImport(SecurityFramework, EntryPoint = "SecKeychainGetUserInteractionAllowed")]
    private static extern int SecKeychainGetUserInteractionAllowed(out byte state);

    [DllImport(SecurityFramework, EntryPoint = "SecKeychainSetUserInteractionAllowed")]
    private static extern int SecKeychainSetUserInteractionAllowed(byte state);

    [DllImport(SecurityFramework, EntryPoint = "SecTrustedApplicationCreateFromPath")]
    private static extern int SecTrustedApplicationCreateFromPath(IntPtr path, out IntPtr trustedApplication);

    [DllImport(SecurityFramework, EntryPoint = "SecAccessCreate")]
    private static extern int SecAccessCreate(IntPtr name, IntPtr trustedList, out IntPtr access);

    [DllImport(CoreFoundation, EntryPoint = "CFArrayCreateMutable")]
    private static extern IntPtr CFArrayCreateMutable(IntPtr allocator, nint capacity, IntPtr callbacks);

    [DllImport(CoreFoundation, EntryPoint = "CFArrayAppendValue")]
    private static extern void CFArrayAppendValue(IntPtr array, IntPtr value);

    [DllImport(CoreFoundation, EntryPoint = "CFRelease")]
    private static extern void CFRelease(IntPtr value);

    private sealed class UnmanagedUtf8 : IDisposable
    {
        public UnmanagedUtf8(string value)
        {
            var bytes = System.Text.Encoding.UTF8.GetBytes(value);
            Pointer = Marshal.AllocHGlobal(bytes.Length + 1);
            Marshal.Copy(bytes, 0, Pointer, bytes.Length);
            Marshal.WriteByte(Pointer, bytes.Length, 0);
            Length = bytes.Length;
        }

        public IntPtr Pointer { get; }

        public int Length { get; }

        public void Dispose() => Marshal.FreeHGlobal(Pointer);
    }
}

/// <summary>
/// Stores a Device identity in an owner-only JSON file. This is intentionally
/// an explicit opt-in seam for isolated launchd smoke/CI environments where
/// invoking the macOS <c>security</c> CLI can require interactive ACL consent.
/// Production macOS configuration should leave <see cref="DeviceNodeOptions.CredentialFilePath"/>
/// unset so the login Keychain remains the default secure store.
/// </summary>
public sealed class OwnerOnlyFileDeviceNodeIdentityStore(IOptions<DeviceNodeOptions> options) : IDeviceNodeIdentityStore
{
    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web);
    private readonly string path = ValidatePath(options.Value.CredentialFilePath);

    public async Task<DeviceNodeIdentity?> LoadAsync(CancellationToken cancellationToken = default)
    {
        if (!File.Exists(path))
        {
            return null;
        }

        EnsureOwnerOnlyPermissions(path);
        await using var stream = File.OpenRead(path);
        return await JsonSerializer.DeserializeAsync<DeviceNodeIdentity>(stream, JsonOptions, cancellationToken)
            .ConfigureAwait(false)
            ?? throw new InvalidDataException("The owner-only Device Node identity file is invalid.");
    }

    public async Task SaveAsync(DeviceNodeIdentity identity, CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(identity);
        Directory.CreateDirectory(Path.GetDirectoryName(path)!);
        if (!OperatingSystem.IsWindows())
        {
            File.SetUnixFileMode(Path.GetDirectoryName(path)!, UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute);
        }

        var temporaryPath = $"{path}.{Guid.NewGuid():N}.tmp";
        try
        {
            await using (var stream = new FileStream(
                temporaryPath,
                FileMode.CreateNew,
                FileAccess.Write,
                FileShare.None,
                4_096,
                FileOptions.Asynchronous | FileOptions.SequentialScan))
            {
                if (!OperatingSystem.IsWindows())
                {
                    File.SetUnixFileMode(temporaryPath, UnixFileMode.UserRead | UnixFileMode.UserWrite);
                }

                await JsonSerializer.SerializeAsync(stream, identity, JsonOptions, cancellationToken).ConfigureAwait(false);
                await stream.FlushAsync(cancellationToken).ConfigureAwait(false);
            }

            File.Move(temporaryPath, path, overwrite: true);
            EnsureOwnerOnlyPermissions(path);
        }
        finally
        {
            if (File.Exists(temporaryPath))
            {
                File.Delete(temporaryPath);
            }
        }
    }

    private static string ValidatePath(string? value)
    {
        if (string.IsNullOrWhiteSpace(value) || !Path.IsPathFullyQualified(value))
        {
            throw new InvalidOperationException("DeviceNode:CredentialFilePath must be an explicit absolute path.");
        }

        var fullPath = Path.GetFullPath(value);
        if (Path.GetPathRoot(fullPath) == fullPath)
        {
            throw new InvalidOperationException("DeviceNode:CredentialFilePath must not be a filesystem root.");
        }

        return fullPath;
    }

    private static void EnsureOwnerOnlyPermissions(string filePath)
    {
        if (OperatingSystem.IsWindows())
        {
            return;
        }

        var mode = File.GetUnixFileMode(filePath);
        var ownerReadWrite = UnixFileMode.UserRead | UnixFileMode.UserWrite;
        if ((mode & ~ownerReadWrite) != 0 || (mode & ownerReadWrite) != ownerReadWrite)
        {
            throw new UnauthorizedAccessException("The Device Node identity file must be owner-readable and owner-writable only.");
        }
    }
}
