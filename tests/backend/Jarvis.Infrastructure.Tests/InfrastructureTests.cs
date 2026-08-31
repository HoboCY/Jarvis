using Jarvis.Infrastructure;
using Jarvis.Application.Responses;
using Jarvis.Infrastructure.Responses;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Options;
using Xunit;

namespace Jarvis.Infrastructure.Tests;

public sealed class InfrastructureTests
{
    [Fact]
    public void InfrastructureAssemblyMarkerIsAvailable()
    {
        Assert.NotNull(typeof(InfrastructureAssemblyMarker).Assembly);
    }

    [Theory]
    [InlineData("Model")]
    [InlineData("SummarizerModel")]
    public void MissingResponsesConfigurationFailsStartupValidation(string missingModel)
    {
        var settings = new Dictionary<string, string?>
        {
            ["OpenAI:ApiKey"] = "test-key",
            ["OpenAI:BaseUrl"] = "https://api.openai.com/",
            ["OpenAI:RealtimeModel"] = "gpt-realtime",
            ["OpenAI:RealtimeVoice"] = "alloy",
            ["OpenAI:AllowedVoices:0"] = "alloy",
            ["OpenAI:SafetyIdentifierSalt"] = "test-salt",
            ["OpenAI:ClientSecretLifetimeSeconds"] = "600",
            ["Responses:Provider"] = "OpenAI",
            ["Responses:Model"] = "gpt-response",
            ["Responses:SummarizerModel"] = "gpt-summary",
            ["Responses:TimeoutSeconds"] = "60",
            ["Responses:MaxTransientRetries"] = "2",
            ["Responses:PollingIntervalMs"] = "250"
        };
        settings.Remove($"Responses:{missingModel}");
        var configuration = new ConfigurationBuilder()
            .AddInMemoryCollection(settings)
            .Build();

        var services = new ServiceCollection();
        services.AddJarvisInfrastructure(configuration);
        using var provider = services.BuildServiceProvider();
        var validator = provider.GetRequiredService<IStartupValidator>();

        var exception = Assert.Throws<OptionsValidationException>(() => validator.Validate());
        Assert.Contains($"Responses:{missingModel} is required", exception.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void RealtimeConfigurationDoesNotRequireResponsesSettings()
    {
        var settings = new Dictionary<string, string?>
        {
            ["OpenAI:ApiKey"] = "test-key",
            ["OpenAI:BaseUrl"] = "https://api.openai.com/",
            ["OpenAI:RealtimeModel"] = "gpt-realtime",
            ["OpenAI:RealtimeVoice"] = "alloy",
            ["OpenAI:AllowedVoices:0"] = "alloy",
            ["OpenAI:SafetyIdentifierSalt"] = "test-salt",
            ["OpenAI:ClientSecretLifetimeSeconds"] = "600",
            ["Responses:Provider"] = "DeepSeek",
            ["Responses:Model"] = "deepseek-v4-flash",
            ["Responses:SummarizerModel"] = "deepseek-v4-flash",
            ["DeepSeek:ApiKey"] = "test-deepseek-key",
            ["DeepSeek:BaseUrl"] = "https://api.deepseek.com/"
        };
        var configuration = new ConfigurationBuilder()
            .AddInMemoryCollection(settings)
            .Build();

        var services = new ServiceCollection();
        services.AddJarvisInfrastructure(configuration);
        using var provider = services.BuildServiceProvider();

        provider.GetRequiredService<IStartupValidator>().Validate();
        var runtime = provider.GetRequiredService<IResponsesRuntime>();
        Assert.IsType<DeepSeekResponsesRuntime>(runtime);
        Assert.IsNotAssignableFrom<IStoredResponsesRuntime>(runtime);
    }

    [Fact]
    public void OpenAiProviderSelectsStoredResponsesRuntime()
    {
        var configuration = CreateConfiguration(new Dictionary<string, string?>
        {
            ["Responses:Provider"] = "OpenAI",
            ["Responses:Model"] = "gpt-response",
            ["Responses:SummarizerModel"] = "gpt-summary"
        });
        var services = new ServiceCollection();
        services.AddJarvisInfrastructure(configuration);
        using var provider = services.BuildServiceProvider();

        provider.GetRequiredService<IStartupValidator>().Validate();
        Assert.IsAssignableFrom<IStoredResponsesRuntime>(provider.GetRequiredService<IResponsesRuntime>());
    }

    [Fact]
    public void UnknownResponsesProviderFailsStartupValidation()
    {
        var configuration = CreateConfiguration(new Dictionary<string, string?>
        {
            ["Responses:Provider"] = "Unsupported",
            ["Responses:Model"] = "model",
            ["Responses:SummarizerModel"] = "summary"
        });
        var services = new ServiceCollection();
        services.AddJarvisInfrastructure(configuration);
        using var provider = services.BuildServiceProvider();

        var exception = Assert.Throws<OptionsValidationException>(
            () => provider.GetRequiredService<IStartupValidator>().Validate());
        Assert.Contains("Responses:Provider must be OpenAI or DeepSeek", exception.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void DeepSeekCredentialsAreRequiredOnlyForTheDeepSeekProvider()
    {
        var configuration = CreateConfiguration(new Dictionary<string, string?>
        {
            ["Responses:Provider"] = "DeepSeek",
            ["Responses:Model"] = "deepseek-v4-flash",
            ["Responses:SummarizerModel"] = "deepseek-v4-flash"
        });
        var services = new ServiceCollection();
        services.AddJarvisInfrastructure(configuration);
        using var provider = services.BuildServiceProvider();

        var exception = Assert.Throws<OptionsValidationException>(
            () => provider.GetRequiredService<IStartupValidator>().Validate());
        Assert.Contains("DeepSeek:ApiKey is required", exception.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void DeepSeekBaseUrlIsRequiredOnlyForTheDeepSeekProvider()
    {
        var configuration = CreateConfiguration(new Dictionary<string, string?>
        {
            ["Responses:Provider"] = "DeepSeek",
            ["Responses:Model"] = "deepseek-v4-flash",
            ["Responses:SummarizerModel"] = "deepseek-v4-flash",
            ["DeepSeek:ApiKey"] = "test-deepseek-key"
        });
        var services = new ServiceCollection();
        services.AddJarvisInfrastructure(configuration);
        using var provider = services.BuildServiceProvider();

        var exception = Assert.Throws<OptionsValidationException>(
            () => provider.GetRequiredService<IStartupValidator>().Validate());
        Assert.Contains("DeepSeek:BaseUrl must be an absolute URI", exception.Message, StringComparison.Ordinal);
    }

    private static IConfiguration CreateConfiguration(Dictionary<string, string?> responses)
    {
        var settings = new Dictionary<string, string?>(responses)
        {
            ["OpenAI:ApiKey"] = "test-key",
            ["OpenAI:BaseUrl"] = "https://api.openai.com/",
            ["OpenAI:RealtimeModel"] = "gpt-realtime",
            ["OpenAI:RealtimeVoice"] = "alloy",
            ["OpenAI:AllowedVoices:0"] = "alloy",
            ["OpenAI:SafetyIdentifierSalt"] = "test-salt",
            ["OpenAI:ClientSecretLifetimeSeconds"] = "600"
        };
        return new ConfigurationBuilder()
            .AddInMemoryCollection(settings)
            .Build();
    }
}
