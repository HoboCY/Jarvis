using System.Net;
using Microsoft.AspNetCore.SignalR.Client;
using Xunit;

namespace Jarvis.Api.IntegrationTests;

public sealed class SignalRTests : IClassFixture<TestApplicationFactory>
{
    private readonly TestApplicationFactory _factory;

    public SignalRTests(TestApplicationFactory factory)
    {
        _factory = factory;
    }

    [Fact]
    public async Task AuthenticatedClientCanCompleteClientHubHandshake()
    {
        await using var connection = CreateConnection(includeToken: true);

        await connection.StartAsync();

        Assert.Equal(HubConnectionState.Connected, connection.State);
        await connection.StopAsync();
    }

    [Fact]
    public async Task UnauthenticatedClientCannotConnectToClientHub()
    {
        await using var connection = CreateConnection(includeToken: false);

        await Assert.ThrowsAnyAsync<Exception>(() => connection.StartAsync());
    }

    [Fact]
    public async Task BrowserStyleNegotiateAcceptsQueryTokenOnlyOnTheHubPath()
    {
        using var client = _factory.CreateClient();

        var response = await client.PostAsync(
            $"/hubs/client/negotiate?negotiateVersion=1&access_token={Uri.EscapeDataString(_factory.Token)}",
            content: null);

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
    }

    [Fact]
    public async Task HubAuthorizationHeaderTakesPriorityOverQueryToken()
    {
        using var client = _factory.CreateClient();
        client.DefaultRequestHeaders.Authorization = new("Bearer", new string('x', _factory.Token.Length));

        var response = await client.PostAsync(
            $"/hubs/client/negotiate?negotiateVersion=1&access_token={Uri.EscapeDataString(_factory.Token)}",
            content: null);

        Assert.Equal(HttpStatusCode.Unauthorized, response.StatusCode);
    }

    private HubConnection CreateConnection(bool includeToken)
    {
        return new HubConnectionBuilder()
            .WithUrl(
                new Uri(_factory.Server.BaseAddress, "/hubs/client"),
                options =>
                {
                    options.HttpMessageHandlerFactory = _ => _factory.Server.CreateHandler();
                    if (includeToken)
                    {
                        options.AccessTokenProvider = () => Task.FromResult<string?>(_factory.Token);
                    }
                })
            .Build();
    }
}
