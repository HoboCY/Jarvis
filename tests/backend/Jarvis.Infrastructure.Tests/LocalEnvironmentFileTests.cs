using Microsoft.Extensions.Configuration;
using Jarvis.Infrastructure.Realtime;
using Xunit;
using Xunit.Sdk;

namespace Jarvis.Infrastructure.Tests;

public sealed class LocalEnvironmentFileTests
{
    [Fact]
    public void ParsesSupportedEntriesAndMapsDoubleUnderscoresToConfigurationPaths()
    {
        using var directory = TemporaryDirectory.Create();
        var path = directory.Write(
            "# local-only configuration\n"
            + "export Authentication__BearerToken = \"token with spaces\"\n"
            + "ConnectionStrings__Jarvis='Data Source=jarvis.db'\n"
            + "OpenAI__ApiKey=unquoted-key\n"
            + "OpenAI__AllowedVoices__0=alloy\n"
            + "Responses__Provider=DeepSeek\n");

        var values = LocalEnvironmentFile.Parse(path);

        Assert.Equal("token with spaces", values["Authentication:BearerToken"]);
        Assert.Equal("Data Source=jarvis.db", values["ConnectionStrings:Jarvis"]);
        Assert.Equal("unquoted-key", values["OpenAI:ApiKey"]);
        Assert.Equal("alloy", values["OpenAI:AllowedVoices:0"]);
        Assert.Equal("DeepSeek", values["Responses:Provider"]);
    }

    [Fact]
    public void MissingFileDoesNotChangeConfiguration()
    {
        using var directory = TemporaryDirectory.Create();
        var configuration = new ConfigurationManager();

        LocalEnvironmentFile.ApplyMissing(
            configuration,
            Path.Combine(directory.Path, ".env"));

        Assert.Empty(configuration.AsEnumerable());
    }

    [Fact]
    public void ExistingConfigurationWinsAndLoaderDoesNotWriteProcessEnvironment()
    {
        const string uniqueEnvironmentKey = "JARVIS_DOTENV_TEST_UNIQUE_KEY";
        var processEnvironmentBefore = Environment.GetEnvironmentVariable(uniqueEnvironmentKey);
        using var directory = TemporaryDirectory.Create();
        var path = directory.Write(
            "Authentication__BearerToken=dotenv-token\n"
            + "ConnectionStrings__Jarvis=dotenv-database\n"
            + $"{uniqueEnvironmentKey}=dotenv-value\n");
        var configuration = new ConfigurationManager();
        configuration.AddInMemoryCollection(new Dictionary<string, string?>
        {
            ["Authentication:BearerToken"] = "existing-token",
            ["ConnectionStrings:Jarvis"] = "existing-database"
        });

        LocalEnvironmentFile.ApplyMissing(configuration, path);

        Assert.Equal("existing-token", configuration["Authentication:BearerToken"]);
        Assert.Equal("existing-database", configuration["ConnectionStrings:Jarvis"]);
        Assert.Equal("dotenv-value", configuration[uniqueEnvironmentKey]);
        Assert.Equal(processEnvironmentBefore, Environment.GetEnvironmentVariable(uniqueEnvironmentKey));
    }

    [Fact]
    public void JsonConfigurationWinsWhenReloadAddsAValueAfterTheEnvSource()
    {
        using var directory = TemporaryDirectory.Create();
        var envPath = directory.Write("Priority__Value=dotenv-value\n");
        var jsonPath = directory.Write("settings.json", "{}\n");
        var configuration = new ConfigurationManager();
        configuration.AddJsonFile(jsonPath, optional: false, reloadOnChange: false);

        LocalEnvironmentFile.ApplyMissing(configuration, envPath);

        Assert.Equal("dotenv-value", configuration["Priority:Value"]);

        File.WriteAllText(jsonPath, "{\"Priority\":{\"Value\":\"json-value\"}}\n");
        ((IConfigurationRoot)configuration).Reload();

        Assert.Equal("json-value", configuration["Priority:Value"]);
    }

    [Fact]
    public void ProcessEnvironmentWinsOverTheEnvSourceAndIsRestoredAfterTheTest()
    {
        var key = $"JARVIS_DOTENV_PROCESS_PRIORITY_{Guid.NewGuid():N}";
        var previous = Environment.GetEnvironmentVariable(key);
        try
        {
            Environment.SetEnvironmentVariable(key, "process-value");
            using var directory = TemporaryDirectory.Create();
            var configuration = new ConfigurationManager();
            configuration.AddEnvironmentVariables();
            var envPath = directory.Write($"{key}=dotenv-value\n");

            LocalEnvironmentFile.ApplyMissing(configuration, envPath);

            Assert.Equal("process-value", configuration[key]);
        }
        finally
        {
            Environment.SetEnvironmentVariable(key, previous);
        }
    }

    [Fact]
    public void CommandLineWinsOverTheEnvSource()
    {
        const string key = "JARVIS_DOTENV_COMMAND_LINE_PRIORITY";
        using var directory = TemporaryDirectory.Create();
        var configuration = new ConfigurationManager();
        configuration.AddCommandLine([$"--{key}=command-line-value"]);
        var envPath = directory.Write($"{key}=dotenv-value\n");

        LocalEnvironmentFile.ApplyMissing(configuration, envPath);

        Assert.Equal("command-line-value", configuration[key]);
    }

    [Fact]
    public void AllowedVoicesArrayBindsFromStandardEnvironmentKeys()
    {
        using var directory = TemporaryDirectory.Create();
        var configuration = new ConfigurationManager();
        var envPath = directory.Write(
            "OpenAI__AllowedVoices__0=alloy\n"
            + "OpenAI__AllowedVoices__1=verse\n");

        LocalEnvironmentFile.ApplyMissing(configuration, envPath);

        var options = configuration
            .GetSection(OpenAiRealtimeOptions.SectionName)
            .Get<OpenAiRealtimeOptions>();
        Assert.NotNull(options);
        Assert.Equal(["alloy", "verse"], options.AllowedVoices);
    }

    [Fact]
    public void PathResolverUsesSelectedWorkingDirectoryWhenNoRepositoryBoundaryExists()
    {
        using var directory = TemporaryDirectory.Create();

        Assert.Equal(
            Path.Combine(directory.Path, ".env"),
            LocalEnvironmentFile.ResolvePath(directory.Path));
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public void DefaultPathResolverUsesCurrentEnvThenRecognizedRepositoryRootOnly(bool gitMarkerIsDirectory)
    {
        using var repository = TemporaryDirectory.Create();
        var nestedDirectory = repository.CreateSubdirectory("src", "backend", "Jarvis.Api");
        var repositoryEnvPath = repository.Write(".env", "root-value\n");
        repository.Write("Jarvis.sln", "solution\n");
        if (gitMarkerIsDirectory)
        {
            Directory.CreateDirectory(System.IO.Path.Combine(repository.Path, ".git"));
        }
        else
        {
            repository.Write(".git", "gitdir: /tmp/jarvis-test-git\n");
        }

        Assert.Equal(repositoryEnvPath, LocalEnvironmentFile.ResolvePath(nestedDirectory));

        var localEnvPath = System.IO.Path.Combine(nestedDirectory, ".env");
        File.WriteAllText(localEnvPath, "local-value\n");
        Assert.Equal(localEnvPath, LocalEnvironmentFile.ResolvePath(nestedDirectory));

        using var unrelatedDirectory = TemporaryDirectory.Create();
        var unrelatedNestedDirectory = unrelatedDirectory.CreateSubdirectory("nested");
        unrelatedDirectory.Write(".env", "unrelated-value\n");
        Assert.Equal(
            System.IO.Path.Combine(unrelatedNestedDirectory, ".env"),
            LocalEnvironmentFile.ResolvePath(unrelatedNestedDirectory));
    }

    [Fact]
    public void DefaultPathResolverDoesNotCrossRepositorySymlinkToAnExternalDirectory()
    {
        using var repository = TemporaryDirectory.Create();
        using var outside = TemporaryDirectory.Create();
        var linkedDirectory = System.IO.Path.Combine(repository.Path, "linked");
        outside.CreateSubdirectory("nested");
        repository.Write(".env", "root-value\n");
        repository.Write("Jarvis.sln", "solution\n");
        Directory.CreateDirectory(System.IO.Path.Combine(repository.Path, ".git"));
        CreateDirectorySymbolicLinkOrSkip(linkedDirectory, outside.Path);

        var workingDirectory = System.IO.Path.Combine(linkedDirectory, "nested");

        Assert.Equal(
            System.IO.Path.Combine(workingDirectory, ".env"),
            LocalEnvironmentFile.ResolvePath(workingDirectory));
    }

    [Theory]
    [InlineData(true)]
    [InlineData(false)]
    public void ASingleRepositoryMarkerDoesNotCreateARepositoryBoundary(bool includeGitMarker)
    {
        using var repository = TemporaryDirectory.Create();
        var nestedDirectory = repository.CreateSubdirectory("nested");
        repository.Write(".env", "root-value\n");
        if (includeGitMarker)
        {
            repository.Write(".git", "gitdir: /tmp/jarvis-test-git\n");
        }
        else
        {
            repository.Write("Jarvis.sln", "solution\n");
        }

        Assert.Equal(
            System.IO.Path.Combine(nestedDirectory, ".env"),
            LocalEnvironmentFile.ResolvePath(nestedDirectory));
    }

    [Fact]
    public void ResolvePathWithoutArgumentUsesTheCurrentWorkingDirectory()
    {
        var expected = LocalEnvironmentFile.ResolvePath(Directory.GetCurrentDirectory());

        Assert.Equal(expected, LocalEnvironmentFile.ResolvePath());
    }

    [Theory]
    [InlineData("OpenAI__ApiKey secret-value")]
    [InlineData("Invalid-Key=secret-value")]
    [InlineData("OpenAI__ApiKey=\"unclosed-secret-value")]
    public void InvalidEntriesIdentifyFileAndLineWithoutLeakingValues(string entry)
    {
        using var directory = TemporaryDirectory.Create();
        var path = directory.Write(entry);

        var exception = Assert.Throws<LocalEnvironmentFileFormatException>(() => LocalEnvironmentFile.Parse(path));

        Assert.Contains(Path.GetFileName(path), exception.Message, StringComparison.Ordinal);
        Assert.Contains("line 1", exception.Message, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("secret-value", exception.ToString(), StringComparison.Ordinal);
    }

    private static void CreateDirectorySymbolicLinkOrSkip(string linkPath, string targetPath)
    {
        try
        {
            Directory.CreateSymbolicLink(linkPath, targetPath);
        }
        catch (PlatformNotSupportedException exception)
        {
            _ = exception;
            throw SkipException.ForSkip("The current platform does not support directory symbolic links.");
        }
        catch (UnauthorizedAccessException exception) when (OperatingSystem.IsWindows())
        {
            _ = exception;
            throw SkipException.ForSkip("The Windows test host cannot create a directory symbolic link without the required capability.");
        }
    }

    private sealed class TemporaryDirectory : IDisposable
    {
        private TemporaryDirectory(string path) => Path = path;

        public string Path { get; }

        public static TemporaryDirectory Create()
        {
            var path = System.IO.Path.Combine(
                System.IO.Path.GetTempPath(),
                $"jarvis-dotenv-tests-{Guid.NewGuid():N}");
            Directory.CreateDirectory(path);
            return new(path);
        }

        public string Write(string contents) => Write(".env", contents);

        public string Write(string fileName, string contents)
        {
            var path = System.IO.Path.Combine(Path, fileName);
            File.WriteAllText(path, contents);
            return path;
        }

        public string CreateSubdirectory(params string[] segments)
        {
            var path = Path;
            foreach (var segment in segments)
            {
                path = System.IO.Path.Combine(path, segment);
            }

            Directory.CreateDirectory(path);
            return path;
        }

        public void Dispose()
        {
            if (Directory.Exists(Path))
            {
                Directory.Delete(Path, recursive: true);
            }
        }
    }
}
