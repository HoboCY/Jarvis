using Jarvis.Api.Configuration;
using System.Text;
using Microsoft.Extensions.Configuration;
using Xunit;

namespace Jarvis.Api.IntegrationTests;

public sealed class ProviderKeySourceTests
{
    [Theory]
    [InlineData("{\"OpenAI:ApiKey\":\"azure-fixture\",\"DeepSeek:ApiKey\":\"deepseek-fixture\",\"Authentication:BearerToken\":\"ignored-fixture\"}")]
    [InlineData("{\"openai\":{\"apikey\":\"azure-fixture\"},\"DeepSeek\":{\"ApiKey\":\"deepseek-fixture\"},\"Authentication\":{\"BearerToken\":\"ignored-fixture\"}}")]
    [InlineData("\uFEFF{\"OpenAI:ApiKey\":\" azure-fixture \",\"DeepSeek:ApiKey\":\" deepseek-fixture \"}")]
    public void LoadsOnlyTheTwoProviderKeysIntoMemory(string source)
    {
        WithSource(source, (configuration, path) =>
        {
            configuration.AddProviderKeySource();

            Assert.Equal("azure-fixture", configuration["OpenAI:ApiKey"]);
            Assert.Equal("deepseek-fixture", configuration["DeepSeek:ApiKey"]);
            Assert.Equal("existing-bearer-fixture", configuration["Authentication:BearerToken"]);
            Assert.Equal(Encoding.UTF8.GetBytes(source), File.ReadAllBytes(path));
            Assert.Single(Directory.GetFiles(Path.GetDirectoryName(path)!));
        });
    }

    [Theory]
    [InlineData("{\"OpenAI:ApiKey\":\"azure-fixture\"}")]
    [InlineData("{\"OpenAI:ApiKey\":null,\"DeepSeek:ApiKey\":\"deepseek-fixture\"}")]
    [InlineData("{\"OpenAI:ApiKey\":123,\"DeepSeek:ApiKey\":\"deepseek-fixture\"}")]
    [InlineData("{ invalid controlled fixture")]
    public void InvalidSourceFailsClosedWithoutFallingBackOrExposingInput(string source)
    {
        WithSource(source, (configuration, path) =>
        {
            var error = Assert.Throws<InvalidOperationException>(() => configuration.AddProviderKeySource());
            Assert.Equal("PROVIDER_KEY_SOURCE_INVALID", error.Message);
            Assert.Null(error.InnerException);
            Assert.DoesNotContain(path, error.ToString());
            Assert.DoesNotContain(source, error.ToString());
        });
    }

    [Fact]
    public void OrdinaryStartupWithoutAKeySourceKeepsExistingConfiguration()
    {
        using var configuration = new ConfigurationManager();
        configuration["OpenAI:ApiKey"] = "ordinary-fixture";
        configuration.AddProviderKeySource();
        Assert.Equal("ordinary-fixture", configuration["OpenAI:ApiKey"]);
    }

    private static void WithSource(string source, Action<ConfigurationManager, string> action)
    {
        var root = Path.Combine(Path.GetTempPath(), $"jarvis-provider-key-source-{Guid.NewGuid():N}");
        Directory.CreateDirectory(root);
        var path = Path.Combine(root, "controlled-fixture.json");
        try
        {
            File.WriteAllText(path, source);
            using var configuration = new ConfigurationManager();
            configuration.AddInMemoryCollection(new Dictionary<string, string?>
            {
                ["ProviderKeySource:Path"] = path,
                ["OpenAI:ApiKey"] = "must-not-fallback-fixture",
                ["DeepSeek:ApiKey"] = "must-not-fallback-fixture",
                ["Authentication:BearerToken"] = "existing-bearer-fixture"
            });
            action(configuration, path);
        }
        finally
        {
            Directory.Delete(root, recursive: true);
        }
    }
}
