using Jarvis.Infrastructure;
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
    [InlineData("ResponsesModel")]
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
            ["OpenAI:ResponsesModel"] = "gpt-response",
            ["OpenAI:SummarizerModel"] = "gpt-summary"
        };
        settings.Remove($"OpenAI:{missingModel}");
        var configuration = new ConfigurationBuilder()
            .AddInMemoryCollection(settings)
            .Build();

        var services = new ServiceCollection();
        services.AddJarvisInfrastructure(configuration);
        using var provider = services.BuildServiceProvider();
        var validator = provider.GetRequiredService<IStartupValidator>();

        var exception = Assert.Throws<OptionsValidationException>(() => validator.Validate());
        Assert.Contains($"OpenAI:{missingModel} is required", exception.Message, StringComparison.Ordinal);
    }
}
