using System.Collections.Concurrent;
using System.Net;
using System.Net.Http.Headers;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using Microsoft.Extensions.Options;

namespace Jarvis.Infrastructure.Budgets;

/// <summary>
/// The live acceptance harness is the only supported source of this section.
/// The default is disabled so normal API and Device Node processes never make
/// a loopback admission request.
/// </summary>
public sealed class Phase9bBudgetAdmissionOptions
{
    public const string SectionName = "BudgetAdmission";

    public bool Enabled { get; set; }

    public string DescriptorPath { get; set; } = string.Empty;

    public string RunId { get; set; } = string.Empty;
}

public sealed record Phase9bBudgetReservation(
    string Kind,
    Guid LogicalId,
    string ReservationId,
    bool Replayed,
    int Remaining);

public interface IPhase9bBudgetAdmission
{
    bool Enabled { get; }

    Task<Phase9bBudgetReservation> ReserveAsync(
        string kind,
        Guid logicalId,
        string requestKey,
        CancellationToken cancellationToken);
}

public sealed class Phase9bBudgetAdmissionException : InvalidOperationException
{
    public Phase9bBudgetAdmissionException(string code)
        : base(code)
    {
        Code = code;
    }

    public string Code { get; }
}

/// <summary>
/// A fail-closed client for the per-run loopback admission server. The
/// descriptor is revalidated for every reservation, while the bearer is read
/// only from its owner-only file and remains in this process memory.
/// </summary>
public sealed class Phase9bBudgetAdmissionClient : IPhase9bBudgetAdmission, IDisposable
{
    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web)
    {
        UnmappedMemberHandling = System.Text.Json.Serialization.JsonUnmappedMemberHandling.Disallow
    };
    private static readonly HashSet<string> Kinds = new(StringComparer.Ordinal)
    {
        "providerRequests",
        "realtimeConnections",
        "delegationAttempts",
        "codexTasks",
        "retries"
    };
    private static readonly HashSet<string> DescriptorProperties = new(StringComparer.Ordinal)
    {
        "schemaVersion",
        "runId",
        "ownerPid",
        "ownerUid",
        "root",
        "endpoint",
        "tokenFile",
        "ledgerFile"
    };
    private readonly Phase9bBudgetAdmissionOptions options;
    private readonly HttpClient httpClient;
    private readonly bool ownsHttpClient;

    public Phase9bBudgetAdmissionClient(IOptions<Phase9bBudgetAdmissionOptions> options)
        : this(options?.Value ?? throw new ArgumentNullException(nameof(options)), CreateHttpClient(), true)
    {
    }

    public Phase9bBudgetAdmissionClient(
        Phase9bBudgetAdmissionOptions options,
        HttpMessageHandler handler)
        : this(options, new HttpClient(handler, true), true)
    {
    }

    private Phase9bBudgetAdmissionClient(
        Phase9bBudgetAdmissionOptions options,
        HttpClient httpClient,
        bool ownsHttpClient)
    {
        this.options = options ?? throw new ArgumentNullException(nameof(options));
        this.httpClient = httpClient ?? throw new ArgumentNullException(nameof(httpClient));
        this.ownsHttpClient = ownsHttpClient;
        if (this.options.Enabled)
        {
            ValidateOptions(this.options);
        }
    }

    public bool Enabled => options.Enabled;

    public async Task<Phase9bBudgetReservation> ReserveAsync(
        string kind,
        Guid logicalId,
        string requestKey,
        CancellationToken cancellationToken)
    {
        if (!Enabled)
        {
            throw new Phase9bBudgetAdmissionException("ADMISSION_DISABLED");
        }

        ValidateRequest(kind, logicalId, requestKey);
        var descriptor = await ReadDescriptorAsync(cancellationToken).ConfigureAwait(false);
        var token = await ReadTokenAsync(descriptor, cancellationToken).ConfigureAwait(false);
        var body = JsonSerializer.Serialize(new ReservationRequest(
            1,
            1,
            kind,
            logicalId,
            requestKey,
            descriptor.RunId), JsonOptions);
        using var request = new HttpRequestMessage(HttpMethod.Post, new Uri(new Uri(descriptor.Endpoint), "reserve"))
        {
            Content = new StringContent(body, System.Text.Encoding.UTF8, "application/json")
        };
        request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", token);
        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        timeout.CancelAfter(TimeSpan.FromSeconds(2));
        HttpResponseMessage response;
        try
        {
            response = await httpClient.SendAsync(
                request,
                HttpCompletionOption.ResponseHeadersRead,
                timeout.Token).ConfigureAwait(false);
        }
        catch (OperationCanceledException) when (!cancellationToken.IsCancellationRequested)
        {
            throw new Phase9bBudgetAdmissionException("ADMISSION_TIMEOUT");
        }
        catch (HttpRequestException)
        {
            throw new Phase9bBudgetAdmissionException("ADMISSION_UNAVAILABLE");
        }

        using (response)
        {
            var responseText = await response.Content.ReadAsStringAsync(timeout.Token).ConfigureAwait(false);
            if (responseText.Length > 16 * 1024)
            {
                throw new Phase9bBudgetAdmissionException("ADMISSION_INVALID");
            }

            if (!response.IsSuccessStatusCode)
            {
                throw new Phase9bBudgetAdmissionException(ReadErrorCategory(responseText));
            }

            ReservationResponse? reservation;
            try
            {
                reservation = JsonSerializer.Deserialize<ReservationResponse>(responseText, JsonOptions);
            }
            catch (JsonException)
            {
                throw new Phase9bBudgetAdmissionException("ADMISSION_INVALID");
            }

            if (reservation is null
                || reservation.SchemaVersion != 1
                || !string.Equals(reservation.Status, "RESERVED", StringComparison.Ordinal)
                || !string.Equals(reservation.RunId, descriptor.RunId, StringComparison.Ordinal)
                || !string.Equals(reservation.Kind, kind, StringComparison.Ordinal)
                || reservation.LogicalId != logicalId
                || reservation.Amount != 1
                || !Guid.TryParse(reservation.ReservationId, out var reservationId)
                || reservation.Remaining < 0)
            {
                throw new Phase9bBudgetAdmissionException("ADMISSION_INVALID");
            }

            return new(kind, logicalId, reservationId.ToString("D"), reservation.Replayed, reservation.Remaining);
        }
    }

    public void Dispose()
    {
        if (ownsHttpClient)
        {
            httpClient.Dispose();
        }
    }

    private async Task<AdmissionDescriptor> ReadDescriptorAsync(CancellationToken cancellationToken)
    {
        ValidateOptions(options);
        ValidatePrivateFile(options.DescriptorPath, 16 * 1024);
        ValidateNoSymlinkPath(options.DescriptorPath);
        var text = await File.ReadAllTextAsync(options.DescriptorPath, cancellationToken).ConfigureAwait(false);
        AdmissionDescriptor? descriptor;
        try
        {
            using var document = JsonDocument.Parse(text);
            ValidateDescriptorProperties(document.RootElement);
            descriptor = JsonSerializer.Deserialize<AdmissionDescriptor>(text, JsonOptions);
        }
        catch (JsonException)
        {
            throw new Phase9bBudgetAdmissionException("ADMISSION_INVALID");
        }

        if (descriptor is null
            || descriptor.SchemaVersion != 1
            || !string.Equals(descriptor.RunId, options.RunId, StringComparison.Ordinal)
            || !Guid.TryParse(descriptor.RunId, out _)
            || descriptor.OwnerPid <= 0
            || descriptor.OwnerUid < 0
            || !Path.IsPathFullyQualified(descriptor.Root)
            || !Path.IsPathFullyQualified(options.DescriptorPath)
            || !Uri.TryCreate(descriptor.Endpoint, UriKind.Absolute, out var endpoint)
            || endpoint.Scheme != Uri.UriSchemeHttp
            || endpoint.Host != IPAddress.Loopback.ToString()
            || endpoint.Port is < 1 or > 65_535
            || endpoint.AbsolutePath != "/"
            || endpoint.Query.Length != 0
            || !IsSafeRelativePath(descriptor.TokenFile)
            || !IsSafeRelativePath(descriptor.LedgerFile))
        {
            throw new Phase9bBudgetAdmissionException("ADMISSION_INVALID");
        }

        if (!OperatingSystem.IsWindows() && descriptor.OwnerUid != GetEffectiveUserId())
        {
            throw new Phase9bBudgetAdmissionException("ADMISSION_OWNERSHIP_INVALID");
        }

        var descriptorDirectory = Path.GetDirectoryName(options.DescriptorPath);
        if (descriptorDirectory is null
            || !PathsEqual(Path.GetFullPath(descriptor.Root), Path.GetFullPath(Path.Combine(descriptorDirectory, "..", ".."))))
        {
            throw new Phase9bBudgetAdmissionException("ADMISSION_OWNERSHIP_INVALID");
        }

        ValidatePrivateDirectory(descriptor.Root);
        ValidateNoSymlinkPath(descriptor.Root);
        var markerPath = Path.Combine(descriptor.Root, ".phase9b-owner.json");
        ValidatePrivateFile(markerPath, 4 * 1024);
        ValidateNoSymlinkPath(markerPath);
        var markerText = await File.ReadAllTextAsync(markerPath, cancellationToken).ConfigureAwait(false);
        try
        {
            using var marker = JsonDocument.Parse(markerText);
            var properties = marker.RootElement.EnumerateObject().Select(property => property.Name).OrderBy(name => name, StringComparer.Ordinal).ToArray();
            if (!properties.SequenceEqual(new[] { "createdAtUtc", "pid", "runId", "schemaVersion" }, StringComparer.Ordinal)
                || marker.RootElement.GetProperty("schemaVersion").GetInt32() != 1
                || marker.RootElement.GetProperty("runId").GetString() != descriptor.RunId
                || marker.RootElement.GetProperty("pid").GetInt64() <= 0
                || marker.RootElement.GetProperty("pid").GetInt64() != descriptor.OwnerPid
                || !DateTimeOffset.TryParse(marker.RootElement.GetProperty("createdAtUtc").GetString(), out _))
            {
                throw new Phase9bBudgetAdmissionException("ADMISSION_OWNERSHIP_INVALID");
            }
        }
        catch (JsonException)
        {
            throw new Phase9bBudgetAdmissionException("ADMISSION_OWNERSHIP_INVALID");
        }

        var tokenPath = Path.Combine(descriptor.Root, descriptor.TokenFile);
        var ledgerPath = Path.Combine(descriptor.Root, descriptor.LedgerFile);
        ValidatePrivateFile(tokenPath, 512);
        ValidatePrivateFile(ledgerPath, 512 * 1024);
        ValidateNoSymlinkPath(tokenPath);
        ValidateNoSymlinkPath(ledgerPath);
        return descriptor with { Endpoint = endpoint.ToString().TrimEnd('/') + "/" };
    }

    private static async Task<string> ReadTokenAsync(
        AdmissionDescriptor descriptor,
        CancellationToken cancellationToken)
    {
        var path = Path.Combine(descriptor.Root, descriptor.TokenFile);
        var text = await File.ReadAllTextAsync(path, cancellationToken).ConfigureAwait(false);
        try
        {
            var token = JsonSerializer.Deserialize<string>(text, JsonOptions);
            if (token is null || token.Length is < 32 or > 256 || token.Any(character => !IsTokenCharacter(character)))
            {
                throw new Phase9bBudgetAdmissionException("ADMISSION_INVALID");
            }

            return token;
        }
        catch (JsonException)
        {
            throw new Phase9bBudgetAdmissionException("ADMISSION_INVALID");
        }
    }

    private static string ReadErrorCategory(string text)
    {
        try
        {
            using var document = JsonDocument.Parse(text);
            if (document.RootElement.ValueKind == JsonValueKind.Object
                && document.RootElement.EnumerateObject().Select(property => property.Name)
                    .OrderBy(name => name, StringComparer.Ordinal)
                    .SequenceEqual(new[] { "errorCategory", "schemaVersion", "status" }, StringComparer.Ordinal)
                && document.RootElement.GetProperty("schemaVersion").GetInt32() == 1
                && document.RootElement.GetProperty("status").GetString() == "REJECTED")
            {
                var category = document.RootElement.GetProperty("errorCategory").GetString();
                return category is "BUDGET_EXHAUSTED"
                    or "ADMISSION_UNAUTHORIZED"
                    or "ADMISSION_UNAVAILABLE"
                    or "ADMISSION_INVALID"
                    or "ADMISSION_INTEGRITY"
                    ? category
                    : "ADMISSION_INVALID";
            }
        }
        catch (JsonException)
        {
            // Deliberately hide provider or host response details.
        }

        return "ADMISSION_INVALID";
    }

    private static void ValidateOptions(Phase9bBudgetAdmissionOptions value)
    {
        if (!value.Enabled
            || !Path.IsPathFullyQualified(value.DescriptorPath)
            || !Guid.TryParse(value.RunId, out _))
        {
            throw new Phase9bBudgetAdmissionException("ADMISSION_INVALID");
        }
    }

    private static void ValidateRequest(string kind, Guid logicalId, string requestKey)
    {
        if (!Kinds.Contains(kind)
            || logicalId == Guid.Empty
            || requestKey.Length is < 1 or > 128
            || requestKey.Any(character => !char.IsAsciiLetterOrDigit(character)
                && character is not ('.' or '_' or ':' or '-')))
        {
            throw new Phase9bBudgetAdmissionException("ADMISSION_INVALID");
        }
    }

    private static void ValidateDescriptorProperties(JsonElement root)
    {
        var names = root.EnumerateObject().Select(property => property.Name);
        if (!names.OrderBy(name => name, StringComparer.Ordinal).SequenceEqual(
                DescriptorProperties.OrderBy(name => name, StringComparer.Ordinal), StringComparer.Ordinal))
        {
            throw new Phase9bBudgetAdmissionException("ADMISSION_INVALID");
        }
    }

    private static bool IsSafeRelativePath(string value) => value.Length is > 0 and <= 240
        && !Path.IsPathFullyQualified(value)
        && !value.Contains('\\')
        && value.Split('/').All(part => part.Length > 0 && part is not ("." or ".."));

    private static bool IsTokenCharacter(char value) => char.IsAsciiLetterOrDigit(value) || value is '_' or '-';

    private static void ValidatePrivateDirectory(string path)
    {
        if (!Directory.Exists(path)
            || IsSymlink(path)
            || !HasOwnerOnlyDirectoryMode(path)
            || !HasOwnerUid(path))
        {
            throw new Phase9bBudgetAdmissionException("ADMISSION_OWNERSHIP_INVALID");
        }
    }

    private static void ValidatePrivateFile(string path, long maximumBytes)
    {
        var info = new FileInfo(path);
        var ownerUidMatches = HasOwnerUid(path);
        if (!info.Exists || info.LinkTarget is not null || info.Length > maximumBytes
            || !HasOwnerOnlyFileMode(path)
            || !ownerUidMatches)
        {
            throw new Phase9bBudgetAdmissionException(
                !ownerUidMatches ? "ADMISSION_OWNERSHIP_INVALID" : "ADMISSION_INVALID");
        }
    }

    private static void ValidateNoSymlinkPath(string path)
    {
        var fullPath = Path.GetFullPath(path);
        var current = Path.GetPathRoot(fullPath) ?? string.Empty;
        foreach (var segment in fullPath[current.Length..].Split(Path.DirectorySeparatorChar, StringSplitOptions.RemoveEmptyEntries))
        {
            current = Path.Combine(current, segment);
            if (IsSymlink(current))
            {
                throw new Phase9bBudgetAdmissionException("ADMISSION_OWNERSHIP_INVALID");
            }
        }
    }

    private static bool IsSymlink(string path) => new FileInfo(path).LinkTarget is not null;

    private static bool HasOwnerOnlyDirectoryMode(string path) =>
        OperatingSystem.IsWindows()
        || File.GetUnixFileMode(path) == (UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute);

    private static bool HasOwnerOnlyFileMode(string path) =>
        OperatingSystem.IsWindows()
        || File.GetUnixFileMode(path) == (UnixFileMode.UserRead | UnixFileMode.UserWrite);

    private static bool HasOwnerUid(string path)
    {
        if (OperatingSystem.IsWindows())
        {
            return true;
        }

        var buffer = Marshal.AllocHGlobal(512);
        var pathBytes = Encoding.UTF8.GetBytes(path + "\0");
        var pathPointer = Marshal.AllocHGlobal(pathBytes.Length);
        try
        {
            Marshal.Copy(pathBytes, 0, pathPointer, pathBytes.Length);
            if (PosixStat(pathPointer, buffer) != 0)
            {
                return false;
            }

            // Darwin's 64-bit struct stat stores uid_t after dev/mode/nlink/
            // ino; Linux's ABI places it after the 64-bit nlink field and
            // mode_t. Both layouts are stable for the supported arm64/x64
            // runners, and the path has already passed the symlink check.
            var uidOffset = OperatingSystem.IsMacOS() ? 16 : 28;
            var uid = unchecked((uint)Marshal.ReadInt32(buffer, uidOffset));
            return uid == unchecked((uint)GetEffectiveUserId());
        }
        finally
        {
            Marshal.FreeHGlobal(pathPointer);
            Marshal.FreeHGlobal(buffer);
        }
    }

    private static bool PathsEqual(string left, string right) => string.Equals(
        left.TrimEnd(Path.DirectorySeparatorChar),
        right.TrimEnd(Path.DirectorySeparatorChar),
        OperatingSystem.IsWindows() || OperatingSystem.IsMacOS()
            ? StringComparison.OrdinalIgnoreCase
            : StringComparison.Ordinal);

    private static HttpClient CreateHttpClient() => new(new HttpClientHandler
    {
        AllowAutoRedirect = false,
        UseProxy = false
    })
    {
        Timeout = TimeSpan.FromSeconds(2)
    };

    private static long GetEffectiveUserId() => geteuid();

    [DllImport("libc", EntryPoint = "geteuid")]
    private static extern long geteuid();

    [DllImport("libc", EntryPoint = "stat", ExactSpelling = true, SetLastError = true)]
    private static extern int PosixStat(
        IntPtr path,
        IntPtr buffer);

    private sealed record ReservationRequest(
        [property: JsonPropertyName("schemaVersion")] int SchemaVersion,
        [property: JsonPropertyName("amount")] int Amount,
        [property: JsonPropertyName("kind")] string Kind,
        [property: JsonPropertyName("logicalId")] Guid LogicalId,
        [property: JsonPropertyName("requestKey")] string RequestKey,
        [property: JsonPropertyName("runId")] string RunId);

    private sealed record ReservationResponse(
        [property: JsonPropertyName("schemaVersion")] int SchemaVersion,
        [property: JsonPropertyName("status")] string Status,
        [property: JsonPropertyName("runId")] string RunId,
        [property: JsonPropertyName("reservationId")] string ReservationId,
        [property: JsonPropertyName("kind")] string Kind,
        [property: JsonPropertyName("logicalId")] Guid LogicalId,
        [property: JsonPropertyName("amount")] int Amount,
        [property: JsonPropertyName("remaining")] int Remaining,
        [property: JsonPropertyName("replayed")] bool Replayed);

    private sealed record AdmissionDescriptor(
        [property: JsonPropertyName("schemaVersion")] int SchemaVersion,
        [property: JsonPropertyName("runId")] string RunId,
        [property: JsonPropertyName("ownerPid")] long OwnerPid,
        [property: JsonPropertyName("ownerUid")] long OwnerUid,
        [property: JsonPropertyName("root")] string Root,
        [property: JsonPropertyName("endpoint")] string Endpoint,
        [property: JsonPropertyName("tokenFile")] string TokenFile,
        [property: JsonPropertyName("ledgerFile")] string LedgerFile);
}

/// <summary>
/// Runs immediately inside the resilience pipeline, so a retry gets a fresh
/// reservation before the provider transport is entered.
/// </summary>
public sealed class Phase9bProviderAdmissionHandler(IPhase9bBudgetAdmission admission) : DelegatingHandler
{
    private static readonly HttpRequestOptionsKey<Guid> LogicalIdKey = new("Jarvis.Phase9b.LogicalId");
    private static readonly HttpRequestOptionsKey<int> AttemptKey = new("Jarvis.Phase9b.Attempt");
    private readonly ConcurrentDictionary<Guid, int> attempts = new();

    protected override async Task<HttpResponseMessage> SendAsync(
        HttpRequestMessage request,
        CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(request);
        if (!admission.Enabled)
        {
            return await base.SendAsync(request, cancellationToken).ConfigureAwait(false);
        }

        var logicalId = request.Options.TryGetValue(LogicalIdKey, out var existingLogicalId)
            ? existingLogicalId
            : CreateLogicalId(request);
        request.Options.Set(LogicalIdKey, logicalId);
        var attempt = request.Options.TryGetValue(AttemptKey, out var existingAttempt)
            ? existingAttempt + 1
            : attempts.AddOrUpdate(logicalId, 1, static (_, previous) => previous + 1);
        attempts.AddOrUpdate(logicalId, attempt, (_, previous) => Math.Max(previous, attempt));
        request.Options.Set(AttemptKey, attempt);
        var wireId = Guid.NewGuid();
        var providerReservation = await admission.ReserveAsync(
            "providerRequests",
            logicalId,
            $"provider:{wireId:D}",
            cancellationToken).ConfigureAwait(false);
        if (attempt > 1 || providerReservation.Replayed)
        {
            await admission.ReserveAsync(
                "retries",
                logicalId,
                $"retry:{wireId:D}",
                cancellationToken).ConfigureAwait(false);
        }

        return await base.SendAsync(request, cancellationToken).ConfigureAwait(false);
    }

    private static Guid CreateLogicalId(HttpRequestMessage request)
    {
        var stableKey = request.Headers.TryGetValues("Idempotency-Key", out var values)
            ? values.FirstOrDefault(value => !string.IsNullOrWhiteSpace(value))
            : null;
        if (string.IsNullOrWhiteSpace(stableKey))
        {
            return Guid.NewGuid();
        }

        var digest = SHA256.HashData(Encoding.UTF8.GetBytes($"jarvis-phase9b:{stableKey}"));
        // Guid(ReadOnlySpan<byte>) interprets the first three fields in the
        // platform's mixed-endian representation. Format the RFC 9562 bytes
        // ourselves so the version/variant nibbles remain at positions 6/8
        // in the textual logical id accepted by the admission server.
        digest[6] = (byte)((digest[6] & 0x0f) | 0x40);
        digest[8] = (byte)((digest[8] & 0x3f) | 0x80);
        var text = string.Create(
            36,
            digest,
            static (destination, bytes) =>
            {
                var hex = Convert.ToHexString(bytes.AsSpan(0, 16)).ToLowerInvariant();
                hex.AsSpan(0, 8).CopyTo(destination);
                destination[8] = '-';
                hex.AsSpan(8, 4).CopyTo(destination[9..]);
                destination[13] = '-';
                hex.AsSpan(12, 4).CopyTo(destination[14..]);
                destination[18] = '-';
                hex.AsSpan(16, 4).CopyTo(destination[19..]);
                destination[23] = '-';
                hex.AsSpan(20, 12).CopyTo(destination[24..]);
            });
        return Guid.ParseExact(text, "D");
    }
}

internal static class Phase9bProviderHttpClient
{
    public static HttpClient Create(IPhase9bBudgetAdmission admission)
    {
        var admissionHandler = new Phase9bProviderAdmissionHandler(admission)
        {
            InnerHandler = new HttpClientHandler
            {
                AllowAutoRedirect = false,
                UseProxy = false
            }
        };
        return new HttpClient(admissionHandler, true)
        {
            Timeout = TimeSpan.FromSeconds(30)
        };
    }
}
