using Jarvis.Application.Devices;
using Jarvis.Contracts;
using System.Security.Cryptography;
using Xunit;

namespace Jarvis.Application.Tests;

public sealed class Phase4CapabilityTests
{
    [Fact]
    public void CapabilityEnvelopeCanonicalizesAllowedRootsAndRejectsTraversalSensitivePaths()
    {
        var root = Path.Combine(Path.GetTempPath(), "jarvis-phase4-root");
        var envelope = new CapabilityEnvelope(
            ReadFiles: true,
            WriteFiles: false,
            RunCommands: false,
            Network: false,
            AllowedRoots: [root]);

        var policy = CapabilityPolicy.Create(envelope);
        Assert.Equal(Path.GetFullPath(root), policy.AllowedRoots.Single());
        Assert.True(policy.IsAllowedPath(Path.Combine(root, "report.md"), write: false));
        Assert.False(policy.IsAllowedPath(Path.Combine(root, "..", ".env"), write: false));
        Assert.False(policy.IsAllowedPath(Path.Combine(root, ".ssh", "id_rsa"), write: false));
        Assert.False(policy.IsAllowedPath(Path.Combine(root, "report.md"), write: true));
    }

    [Fact]
    public void CapabilityPolicyRejectsRelativeAndEmptyRootsAndDoesNotUsePrefixSiblings()
    {
        Assert.Throws<ArgumentException>(() => CapabilityPolicy.Create(new CapabilityEnvelope(ReadFiles: true, AllowedRoots: ["relative-root"])));
        Assert.Throws<ArgumentException>(() => CapabilityPolicy.Create(new CapabilityEnvelope(ReadFiles: true, AllowedRoots: [""])));

        var root = Path.Combine(Path.GetTempPath(), $"jarvis-phase4-boundary-{Guid.NewGuid():N}");
        var policy = CapabilityPolicy.Create(new CapabilityEnvelope(ReadFiles: true, AllowedRoots: [root]));

        Assert.True(policy.IsAllowedPath(root, write: false));
        Assert.True(policy.IsAllowedPath(Path.Combine(root, "nested", "file.txt"), write: false));
        Assert.False(policy.IsAllowedPath($"{root}-evil{Path.DirectorySeparatorChar}file.txt", write: false));
    }

    [Fact]
    public void CapabilityPolicyResolvesDirectoryAndFileSymlinksBeforeBoundaryCheck()
    {
        if (OperatingSystem.IsWindows())
        {
            return;
        }

        var parent = Directory.CreateTempSubdirectory("jarvis-phase4-symlink-");
        var root = Directory.CreateDirectory(Path.Combine(parent.FullName, "root"));
        var outside = Directory.CreateDirectory(Path.Combine(parent.FullName, "outside"));
        var outsideFile = Path.Combine(outside.FullName, "secret.txt");
        File.WriteAllText(outsideFile, "secret");
        var directoryLink = Path.Combine(root.FullName, "linked");
        var fileLink = Path.Combine(root.FullName, "linked-file.txt");
        Directory.CreateSymbolicLink(directoryLink, outside.FullName);
        File.CreateSymbolicLink(fileLink, outsideFile);

        try
        {
            var policy = CapabilityPolicy.Create(new CapabilityEnvelope(ReadFiles: true, AllowedRoots: [root.FullName]));
            Assert.False(policy.IsAllowedPath(Path.Combine(directoryLink, "secret.txt"), write: false));
            Assert.False(policy.IsAllowedPath(fileLink, write: false));
            Assert.False(policy.IsAllowedPath(Path.Combine(root.FullName, ".ssh", "id_rsa"), write: false));
            Assert.False(policy.IsAllowedPath(Path.Combine(root.FullName, ".env"), write: false));
        }
        finally
        {
            parent.Delete(recursive: true);
        }
    }

    [Fact]
    public void ArtifactManifestValidatorRequiresCanonicalRegularFilesWithMatchingHashAndSize()
    {
        var parent = Directory.CreateTempSubdirectory("jarvis-phase4-artifacts-");
        var root = Directory.CreateDirectory(Path.Combine(parent.FullName, "root"));
        var file = Path.Combine(root.FullName, "result.txt");
        File.WriteAllText(file, "result");
        var bytes = File.ReadAllBytes(file);
        var manifest = new ArtifactManifestEntry(
            file,
            bytes.LongLength,
            Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant(),
            "text/plain");
        var policy = CapabilityPolicy.Create(new CapabilityEnvelope(ReadFiles: true, AllowedRoots: [root.FullName]));
        try
        {
            Assert.True(ArtifactManifestValidator.TryValidateLocalFiles(policy, [manifest], out var error), error);
            Assert.False(ArtifactManifestValidator.TryValidateLocalFiles(policy, [manifest with { Size = manifest.Size + 1 }], out _));
            Assert.False(ArtifactManifestValidator.TryValidateLocalFiles(policy, [manifest with { Sha256 = "00" }], out _));
            Assert.False(ArtifactManifestValidator.TryValidateLocalFiles(policy, [manifest with { Path = root.FullName }], out _));

            var remotePath = Path.Combine(root.FullName, "remote-device-only.txt");
            var remoteManifest = manifest with { Path = remotePath };
            Assert.True(ArtifactManifestValidator.TryValidateDeclaration(policy, [remoteManifest], out error), error);
            Assert.False(ArtifactManifestValidator.TryValidateLocalFiles(policy, [remoteManifest], out _));
        }
        finally
        {
            parent.Delete(recursive: true);
        }
    }
}
