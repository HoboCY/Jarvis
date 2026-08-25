using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Microsoft.AspNetCore.Mvc.Testing;
using Xunit;

namespace Jarvis.Api.IntegrationTests;

public sealed class ApiTests : IClassFixture<TestApplicationFactory>
{
    private readonly HttpClient _client;

    public ApiTests(TestApplicationFactory factory)
    {
        _client = factory.CreateClient();
    }

    [Fact]
    public void ApiAssemblyIsLoadable()
    {
        var apiAssembly = typeof(Program).Assembly;

        Assert.Equal("Jarvis.Api", apiAssembly.GetName().Name);
    }

    [Fact]
    public async Task ConversationApiRequiresAuthentication()
    {
        var response = await _client.PostAsJsonAsync("/api/v1/conversations", new { title = "private" });

        Assert.Equal(HttpStatusCode.Unauthorized, response.StatusCode);
        Assert.Equal("application/problem+json", response.Content.Headers.ContentType?.MediaType);
    }

    [Fact]
    public async Task HealthAndOpenApiRemainAnonymous()
    {
        var health = await _client.GetAsync("/api/v1/phase0/health");
        var openApi = await _client.GetAsync("/openapi/v1.json");

        Assert.Equal(HttpStatusCode.OK, health.StatusCode);
        Assert.Equal(HttpStatusCode.OK, openApi.StatusCode);
    }

    [Fact]
    public async Task OpenApiDescribesLocalBearerForProtectedConversationOperationsOnly()
    {
        using var document = JsonDocument.Parse(await _client.GetStringAsync("/openapi/v1.json"));
        var root = document.RootElement;
        var scheme = root.GetProperty("components")
            .GetProperty("securitySchemes")
            .GetProperty("LocalBearer");
        Assert.Equal("http", scheme.GetProperty("type").GetString());
        Assert.Equal("bearer", scheme.GetProperty("scheme").GetString());

        var protectedOperation = root.GetProperty("paths")
            .GetProperty("/api/v1/conversations")
            .GetProperty("post");
        Assert.Equal("LocalBearer", protectedOperation.GetProperty("security")[0].EnumerateObject().Single().Name);
        Assert.True(protectedOperation.GetProperty("responses").TryGetProperty("401", out var unauthorized));
        Assert.True(unauthorized.GetProperty("content").TryGetProperty("application/problem+json", out _));

        var healthOperation = root.GetProperty("paths")
            .GetProperty("/api/v1/phase0/health")
            .GetProperty("get");
        Assert.False(healthOperation.TryGetProperty("security", out _));
    }

}
