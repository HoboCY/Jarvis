using System.Buffers;

namespace Jarvis.Application.Devices;

public sealed record CapabilityEnvelope(
    bool ReadFiles = false,
    bool WriteFiles = false,
    bool RunCommands = false,
    bool Network = false,
    IReadOnlyList<string>? AllowedRoots = null);

public sealed class CapabilityPolicy
{
    private static readonly SearchValues<char> GlobMetaCharacters = SearchValues.Create("*?[]{}");
    private static readonly HashSet<string> SensitiveNames = new(StringComparer.OrdinalIgnoreCase)
    {
        ".env",
        ".ssh",
        ".aws",
        ".azure",
        ".config/gcloud",
        "id_rsa",
        "id_ed25519",
        "credentials",
        "secrets.json"
    };

    private CapabilityPolicy(CapabilityEnvelope envelope, IReadOnlyList<string> roots)
    {
        ReadFiles = envelope.ReadFiles;
        WriteFiles = envelope.WriteFiles;
        RunCommands = envelope.RunCommands;
        Network = envelope.Network;
        AllowedRoots = roots;
    }

    public bool ReadFiles { get; }

    public bool WriteFiles { get; }

    public bool RunCommands { get; }

    public bool Network { get; }

    public IReadOnlyList<string> AllowedRoots { get; }

    public static CapabilityPolicy Create(CapabilityEnvelope envelope)
    {
        ArgumentNullException.ThrowIfNull(envelope);
        var roots = (envelope.AllowedRoots ?? Array.Empty<string>())
            .Select(root => Canonicalize(root, nameof(envelope.AllowedRoots)))
            .Distinct(StringComparer.Ordinal)
            .ToArray();
        return new CapabilityPolicy(envelope, roots);
    }

    public bool IsAllowedPath(string path, bool write)
    {
        if (string.IsNullOrWhiteSpace(path) || (write ? !WriteFiles : !ReadFiles))
        {
            return false;
        }

        if (!TryCanonicalize(path, out var canonicalPath))
        {
            return false;
        }

        var resolvedPath = ResolveExistingComponents(canonicalPath);
        if (IsSensitive(canonicalPath) || IsSensitive(resolvedPath))
        {
            return false;
        }

        return AllowedRoots.Any(root => IsWithinRoot(ResolveExistingComponents(root), resolvedPath));
    }

    public static bool TryGetCanonicalPath(string path, out string canonicalPath) => TryCanonicalize(path, out canonicalPath);

    public bool IsAllowedCommand() => RunCommands;

    public IReadOnlyDictionary<string, string> BuildMinimalEnvironment(IReadOnlyDictionary<string, string>? additional = null)
    {
        _ = AllowedRoots.Count;
        var result = new Dictionary<string, string>(StringComparer.Ordinal)
        {
            ["PATH"] = Environment.GetEnvironmentVariable("PATH") ?? string.Empty,
            ["LANG"] = Environment.GetEnvironmentVariable("LANG") ?? "C.UTF-8"
        };
        if (additional is not null)
        {
            foreach (var pair in additional)
            {
                if (IsSafeEnvironmentName(pair.Key))
                {
                    result[pair.Key] = pair.Value;
                }
            }
        }

        return result;
    }

    private static bool TryCanonicalize(string path, out string canonicalPath)
    {
        try
        {
            canonicalPath = Canonicalize(path, nameof(path));
            return true;
        }
        catch (ArgumentException)
        {
            canonicalPath = string.Empty;
            return false;
        }
        catch (IOException)
        {
            canonicalPath = string.Empty;
            return false;
        }
    }

    private static string Canonicalize(string path, string parameterName)
    {
        if (string.IsNullOrWhiteSpace(path))
        {
            throw new ArgumentException("A capability path must not be empty.", parameterName);
        }

        if (HasTraversalSegment(path))
        {
            throw new ArgumentException("A capability path must not contain a parent traversal segment.", parameterName);
        }

        if (!Path.IsPathFullyQualified(path))
        {
            throw new ArgumentException("A capability path must be absolute.", parameterName);
        }

        // Codex permission roots are emitted as filesystem glob keys. Reject
        // metacharacters at the capability boundary instead of attempting an
        // unverified escape that could change the native glob semantics.
        if (path.AsSpan().IndexOfAny(GlobMetaCharacters) >= 0)
        {
            throw new ArgumentException("A capability path must not contain filesystem glob metacharacters.", parameterName);
        }

        var fullPath = Path.GetFullPath(path);
        // Keep the caller's lexical absolute spelling as the public
        // canonical path. Physical link resolution is performed separately
        // by IsAllowedPath so system aliases such as macOS /var remain stable
        // while user-controlled symlink escapes are still denied.
        return TrimTrailingSeparators(fullPath);
    }

    private static string ResolveExistingComponents(string fullPath)
    {
        var root = Path.GetPathRoot(fullPath)
            ?? throw new ArgumentException("A capability path must have a root.", nameof(fullPath));
        var current = root;
        var remainder = fullPath[root.Length..]
            .Split([Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar], StringSplitOptions.RemoveEmptyEntries);

        for (var index = 0; index < remainder.Length; index++)
        {
            var candidate = Path.Combine(current, remainder[index]);
            if (!Directory.Exists(candidate) && !File.Exists(candidate))
            {
                current = Path.Combine(current, string.Join(Path.DirectorySeparatorChar, remainder[index..]));
                break;
            }

            FileSystemInfo info = Directory.Exists(candidate)
                ? new DirectoryInfo(candidate)
                : new FileInfo(candidate);
            var target = info.ResolveLinkTarget(returnFinalTarget: true);
            current = target?.FullName ?? candidate;
        }

        return TrimTrailingSeparators(Path.GetFullPath(current));
    }

    private static string TrimTrailingSeparators(string path)
    {
        var root = Path.GetPathRoot(path);
        if (string.Equals(path, root, OperatingSystem.IsWindows() ? StringComparison.OrdinalIgnoreCase : StringComparison.Ordinal))
        {
            return path;
        }

        return path.TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
    }

    private static bool HasTraversalSegment(string path) => path
        .Split([Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar], StringSplitOptions.None)
        .Any(segment => string.Equals(segment, "..", StringComparison.Ordinal));

    private static bool IsWithinRoot(string root, string path)
    {
        var relative = Path.GetRelativePath(root, path);
        return relative != ".."
            && !relative.StartsWith($"..{Path.DirectorySeparatorChar}", StringComparison.Ordinal)
            && !Path.IsPathRooted(relative);
    }

    private static bool IsSensitive(string path)
    {
        var segments = path.Split([Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar], StringSplitOptions.RemoveEmptyEntries);
        for (var index = 0; index < segments.Length; index++)
        {
            if (SensitiveNames.Contains(segments[index]))
            {
                return true;
            }

            if (index > 0 && string.Equals(segments[index - 1], ".config", StringComparison.OrdinalIgnoreCase)
                && string.Equals(segments[index], "gcloud", StringComparison.OrdinalIgnoreCase))
            {
                return true;
            }
        }

        return false;
    }

    private static bool IsSafeEnvironmentName(string name) =>
        name.Length is > 0 and <= 64
        && name.All(character => char.IsLetterOrDigit(character) || character == '_')
        && !name.Contains("KEY", StringComparison.OrdinalIgnoreCase)
        && !name.Contains("TOKEN", StringComparison.OrdinalIgnoreCase)
        && !name.Contains("SECRET", StringComparison.OrdinalIgnoreCase);
}
