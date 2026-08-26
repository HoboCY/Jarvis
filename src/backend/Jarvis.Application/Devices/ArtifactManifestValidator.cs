using System.Security.Cryptography;
using Jarvis.Contracts;

namespace Jarvis.Application.Devices;

public static class ArtifactManifestValidator
{
    public static bool TryValidateDeclaration(
        CapabilityPolicy policy,
        IReadOnlyList<ArtifactManifestEntry>? artifacts,
        out string error)
    {
        ArgumentNullException.ThrowIfNull(policy);
        if (artifacts is null || artifacts.Count > 100)
        {
            error = "An artifact manifest is required and must contain at most 100 files.";
            return false;
        }

        var seen = new HashSet<string>(GetPathComparer());
        foreach (var artifact in artifacts)
        {
            if (artifact is null
                || string.IsNullOrWhiteSpace(artifact.Path)
                || artifact.Path.Length > 4_000
                || artifact.Size < 0
                || string.IsNullOrWhiteSpace(artifact.Sha256)
                || !IsSha256(artifact.Sha256)
                || string.IsNullOrWhiteSpace(artifact.ContentType)
                || artifact.ContentType.Length > 200)
            {
                error = "The artifact manifest contains an invalid entry.";
                return false;
            }

            if (!CapabilityPolicy.TryGetCanonicalPath(artifact.Path, out var canonicalPath)
                || !policy.IsAllowedPath(artifact.Path, write: false)
                || !PathsEqual(Path.GetFullPath(artifact.Path), canonicalPath)
                || !seen.Add(canonicalPath))
            {
                error = "The artifact path must be canonical and within an allowed root.";
                return false;
            }
        }

        error = string.Empty;
        return true;
    }

    public static bool TryValidateLocalFiles(
        CapabilityPolicy policy,
        IReadOnlyList<ArtifactManifestEntry>? artifacts,
        out string error)
    {
        if (!TryValidateDeclaration(policy, artifacts, out error))
        {
            return false;
        }

        foreach (var artifact in artifacts!)
        {
            var canonicalPath = Path.GetFullPath(artifact.Path);
            if (!File.Exists(canonicalPath) || HasReparsePoint(policy, artifact.Path))
            {
                error = "The artifact path must identify a canonical regular file on the Device Node.";
                return false;
            }

            var fileInfo = new FileInfo(canonicalPath);
            if ((fileInfo.Attributes & FileAttributes.Directory) != 0
                || (fileInfo.Attributes & FileAttributes.ReparsePoint) != 0
                || fileInfo.Length != artifact.Size)
            {
                error = "The artifact file is not a regular file with the declared size.";
                return false;
            }

            string hash;
            try
            {
                hash = Convert.ToHexString(SHA256.HashData(File.ReadAllBytes(canonicalPath)));
            }
            catch (IOException)
            {
                error = "The artifact file could not be read.";
                return false;
            }

            if (!string.Equals(hash, artifact.Sha256, StringComparison.OrdinalIgnoreCase))
            {
                error = "The artifact hash does not match the file contents.";
                return false;
            }
        }

        error = string.Empty;
        return true;
    }

    public static void EnsureLocalFilesValid(CapabilityPolicy policy, IReadOnlyList<ArtifactManifestEntry>? artifacts)
    {
        if (!TryValidateLocalFiles(policy, artifacts, out var error))
        {
            throw new InvalidDataException(error);
        }
    }

    private static bool HasReparsePoint(CapabilityPolicy policy, string path)
    {
        var fullPath = Path.GetFullPath(path);
        var declaredRoot = policy.AllowedRoots.FirstOrDefault(root => IsWithinLexicalRoot(root, fullPath));
        if (declaredRoot is null)
        {
            return true;
        }

        // Reparse points in an OS alias that is part of the declared root
        // (for example macOS /var -> /private/var) are harmless. Any link
        // below that root would make the manifest non-canonical.
        var current = declaredRoot;
        var parts = Path.GetRelativePath(declaredRoot, fullPath)
            .Split([Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar], StringSplitOptions.RemoveEmptyEntries);
        foreach (var part in parts)
        {
            current = Path.Combine(current, part);
            if (!File.Exists(current) && !Directory.Exists(current))
            {
                return true;
            }

            var attributes = File.GetAttributes(current);
            if ((attributes & FileAttributes.ReparsePoint) != 0)
            {
                return true;
            }
        }

        return false;
    }

    private static bool IsWithinLexicalRoot(string root, string path)
    {
        var relative = Path.GetRelativePath(root, path);
        return relative != ".."
            && !relative.StartsWith($"..{Path.DirectorySeparatorChar}", StringComparison.Ordinal)
            && !Path.IsPathRooted(relative);
    }

    private static bool IsSha256(string value) => value.Length == 64 && value.All(Uri.IsHexDigit);

    private static bool PathsEqual(string left, string right) => string.Equals(
        left.TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar),
        right.TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar),
        OperatingSystem.IsWindows() ? StringComparison.OrdinalIgnoreCase : StringComparison.Ordinal);

    private static StringComparer GetPathComparer() => OperatingSystem.IsWindows()
        ? StringComparer.OrdinalIgnoreCase
        : StringComparer.Ordinal;
}
