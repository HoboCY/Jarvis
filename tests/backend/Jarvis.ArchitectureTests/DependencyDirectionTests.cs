using System;
using System.IO;
using System.Linq;
using System.Xml.Linq;
using Jarvis.Domain;
using Xunit;

namespace Jarvis.ArchitectureTests;

public sealed class DependencyDirectionTests
{
    [Fact]
    public void Phase0BackendProjectsExistBeforeDependencyDirectionIsChecked()
    {
        var root = FindRepositoryRoot();
        var requiredProjects = new[]
        {
            "Jarvis.Api",
            "Jarvis.Application",
            "Jarvis.Domain",
            "Jarvis.Infrastructure",
            "Jarvis.DeviceNode",
            "Jarvis.Contracts"
        };

        foreach (var project in requiredProjects)
        {
            var path = Path.Combine(root, "src", "backend", project, $"{project}.csproj");
            Assert.True(File.Exists(path), $"Expected Phase 0 project was not found: {path}");
        }
    }

    [Fact]
    public void BackendProjectReferencesFollowTheLockedDirection()
    {
        var root = FindRepositoryRoot();
        var expected = new Dictionary<string, string[]>(StringComparer.Ordinal)
        {
            ["Jarvis.Domain"] = [],
            ["Jarvis.Contracts"] = [],
            ["Jarvis.Application"] = ["Jarvis.Domain", "Jarvis.Contracts"],
            ["Jarvis.Infrastructure"] = ["Jarvis.Application", "Jarvis.Domain", "Jarvis.Contracts"],
            ["Jarvis.Api"] = ["Jarvis.Application", "Jarvis.Infrastructure", "Jarvis.Contracts"],
            ["Jarvis.DeviceNode"] = ["Jarvis.Application", "Jarvis.Infrastructure", "Jarvis.Contracts"]
        };

        foreach (var (project, dependencies) in expected)
        {
            var path = Path.Combine(root, "src", "backend", project, $"{project}.csproj");
            var actual = XDocument.Load(path)
                .Descendants("ProjectReference")
                .Select(reference => Path.GetFileNameWithoutExtension((string?)reference.Attribute("Include") ?? string.Empty))
                .OrderBy(name => name, StringComparer.Ordinal)
                .ToArray();

            Assert.Equal(dependencies.OrderBy(name => name, StringComparer.Ordinal), actual);
        }
    }

    [Fact]
    public void DomainAssemblyDoesNotReferenceInfrastructure()
    {
        var referencedAssemblyNames = typeof(DomainAssemblyMarker).Assembly
            .GetReferencedAssemblies()
            .Select(assembly => assembly.Name)
            .Where(name => name is not null)
            .ToArray();

        Assert.DoesNotContain("Jarvis.Infrastructure", referencedAssemblyNames);
    }

    [Fact]
    public void DomainProjectAndAssemblyDoNotReferenceForbiddenRuntimes()
    {
        var root = FindRepositoryRoot();
        var projectPath = Path.Combine(root, "src", "backend", "Jarvis.Domain", "Jarvis.Domain.csproj");
        var project = XDocument.Load(projectPath);
        var projectReferences = project
            .Descendants("ProjectReference")
            .Select(reference => (string?)reference.Attribute("Include") ?? string.Empty)
            .ToArray();
        var packageReferences = project
            .Descendants("PackageReference")
            .Select(reference => (string?)reference.Attribute("Include") ?? string.Empty)
            .ToArray();

        Assert.Empty(projectReferences);
        Assert.Empty(packageReferences);
        Assert.DoesNotContain(projectReferences, IsForbiddenRuntimeDependency);
        Assert.DoesNotContain(packageReferences, IsForbiddenRuntimeDependency);

        var referencedAssemblyNames = typeof(DomainAssemblyMarker).Assembly
            .GetReferencedAssemblies()
            .Select(assembly => assembly.Name ?? string.Empty)
            .ToArray();

        Assert.DoesNotContain(referencedAssemblyNames, IsForbiddenRuntimeDependency);
    }

    private static bool IsForbiddenRuntimeDependency(string dependency)
    {
        var forbiddenTerms = new[] { "EntityFramework", "OpenAI", "SignalR", "Codex" };
        return forbiddenTerms.Any(term => dependency.Contains(term, StringComparison.OrdinalIgnoreCase));
    }

    private static string FindRepositoryRoot()
    {
        var current = new DirectoryInfo(Directory.GetCurrentDirectory());
        while (current is not null && !File.Exists(Path.Combine(current.FullName, "AGENTS.md")))
        {
            current = current.Parent;
        }

        return current?.FullName ?? throw new InvalidOperationException("Repository root was not found.");
    }
}
