using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using System.Net.Http.Headers;
using System.Data;
using Jarvis.Contracts;
using Jarvis.Application.Realtime;
using Jarvis.Domain.Devices;
using Microsoft.Data.Sqlite;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.AspNetCore.SignalR.Client;
using Xunit;

namespace Jarvis.Api.IntegrationTests;

public sealed class Phase7MobilePairingTests
{
    [Fact]
    public async Task LocalUserCanCreateASingleUseMobilePairingCode()
    {
        await using var factory = new TestApplicationFactory();
        using var client = factory.CreateClient();
        client.DefaultRequestHeaders.Authorization =
            new System.Net.Http.Headers.AuthenticationHeaderValue("Bearer", factory.Token);

        using var request = new HttpRequestMessage(HttpMethod.Post, "/api/v1/mobile-pairings")
        {
            Content = JsonContent.Create(new
            {
                deviceName = "Phone",
                platform = "ios"
            })
        };
        request.Headers.Add("Idempotency-Key", "phase7-pairing-create-1");

        using var response = await client.SendAsync(request);

        Assert.Equal(HttpStatusCode.Created, response.StatusCode);
        var body = await response.Content.ReadFromJsonAsync<JsonElement>();
        Assert.False(body.TryGetProperty("codeHash", out _));
        Assert.True(body.GetProperty("code").GetString()?.Length >= 32);
    }

    [Fact]
    public async Task PairingExchangeCreatesMobileSessionAndSafeDeviceProjection()
    {
        await using var factory = new TestApplicationFactory();
        using var local = CreateAuthenticatedClient(factory, factory.Token);
        var pairing = await CreatePairingAsync(local, "phase7-pairing-exchange");

        using var exchange = await local.PostAsJsonAsync(
            "/api/v1/mobile-pairings/exchange",
            new MobilePairingExchangeRequest(pairing.Code, "My Phone", "ios", ["microphone"]));

        Assert.Equal(HttpStatusCode.OK, exchange.StatusCode);
        var session = await exchange.Content.ReadFromJsonAsync<MobileSessionResponse>();
        Assert.NotNull(session);
        Assert.StartsWith("jma_", session!.AccessToken, StringComparison.Ordinal);
        Assert.StartsWith("jrefresh_", session.RefreshToken, StringComparison.Ordinal);

        using var mobile = CreateAuthenticatedClient(factory, session.AccessToken);
        using (var mobilePairingAttempt = new HttpRequestMessage(HttpMethod.Post, "/api/v1/mobile-pairings")
        {
            Content = JsonContent.Create(new MobilePairingRequest("Another Phone", "android"))
        })
        {
            mobilePairingAttempt.Headers.Authorization = new AuthenticationHeaderValue("Bearer", session.AccessToken);
            mobilePairingAttempt.Headers.Add("Idempotency-Key", "phase7-mobile-cannot-create-pairing");
            using var mobilePairingResponse = await mobile.SendAsync(mobilePairingAttempt);
            Assert.Equal(HttpStatusCode.Unauthorized, mobilePairingResponse.StatusCode);
        }

        using (var mobileDesktopBootstrap = new HttpRequestMessage(HttpMethod.Post, "/api/v1/realtime/desktop-device"))
        {
            mobileDesktopBootstrap.Headers.Add("Idempotency-Key", "phase7-mobile-cannot-bootstrap-desktop");
            using var mobileDesktopResponse = await mobile.SendAsync(mobileDesktopBootstrap);
            Assert.Equal(HttpStatusCode.Unauthorized, mobileDesktopResponse.StatusCode);
        }

        await using (var scope = factory.Services.CreateAsyncScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<Jarvis.Infrastructure.Data.JarvisDbContext>();
            var storedPairing = await db.MobilePairings.SingleAsync(item => item.Id == pairing.PairingId);
            Assert.NotEqual(pairing.Code, storedPairing.CodeHash);
            Assert.Equal(64, storedPairing.CodeHash.Length);
            var storedSession = await db.MobileSessions.SingleAsync(item => item.Id == session.SessionId);
            Assert.NotEqual(session.RefreshToken, storedSession.RefreshTokenHash);
            Assert.Equal(64, storedSession.RefreshTokenHash.Length);
        }

        using var devices = await mobile.GetAsync("/api/v1/devices?deviceType=desktop");
        Assert.Equal(HttpStatusCode.OK, devices.StatusCode);
        var deviceBody = await devices.Content.ReadAsStringAsync();
        Assert.DoesNotContain("credential", deviceBody, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("allowedRoots", deviceBody, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("refreshToken", deviceBody, StringComparison.OrdinalIgnoreCase);
        Assert.Contains("Local Desktop", deviceBody, StringComparison.Ordinal);

        var conversation = await CreateConversationAsync(local, "phase7-mobile-conversation");
        using var typed = new HttpRequestMessage(
            HttpMethod.Post,
            $"/api/v1/conversations/{conversation.Id}/messages/typed")
        {
            Content = JsonContent.Create(new TypedMessageRequest("phase7-mobile-message", "手机输入"))
        };
        typed.Headers.Add("Idempotency-Key", "phase7-mobile-message");
        using var typedResponse = await mobile.SendAsync(typed);
        Assert.Equal(HttpStatusCode.OK, typedResponse.StatusCode);
    }

    [Fact]
    public async Task RefreshRotatesTheOldTokenAndRevokeInvalidatesAccessAndRefresh()
    {
        await using var factory = new TestApplicationFactory();
        using var local = CreateAuthenticatedClient(factory, factory.Token);
        var pairing = await CreatePairingAsync(local, "phase7-pairing-rotate");
        var session = await ExchangeAsync(local, pairing.Code);

        using var firstRefresh = await local.PostAsJsonAsync(
            "/api/v1/mobile-sessions/refresh",
            new MobileSessionRefreshRequest(session.SessionId, session.RefreshToken));
        Assert.Equal(HttpStatusCode.OK, firstRefresh.StatusCode);
        var rotated = await firstRefresh.Content.ReadFromJsonAsync<MobileSessionResponse>();
        Assert.NotNull(rotated);
        Assert.NotEqual(session.RefreshToken, rotated!.RefreshToken);

        using var replay = await local.PostAsJsonAsync(
            "/api/v1/mobile-sessions/refresh",
            new MobileSessionRefreshRequest(session.SessionId, session.RefreshToken));
        Assert.Equal(HttpStatusCode.Unauthorized, replay.StatusCode);

        using var mobile = CreateAuthenticatedClient(factory, rotated.AccessToken);
        using var revoke = await mobile.PostAsync("/api/v1/mobile-sessions/revoke", content: null);
        Assert.Equal(HttpStatusCode.OK, revoke.StatusCode);
        using var revokedAccess = await mobile.GetAsync("/api/v1/devices");
        Assert.Equal(HttpStatusCode.Unauthorized, revokedAccess.StatusCode);
        using var revokedRefresh = await local.PostAsJsonAsync(
            "/api/v1/mobile-sessions/refresh",
            new MobileSessionRefreshRequest(rotated.SessionId, rotated.RefreshToken));
        Assert.Equal(HttpStatusCode.Unauthorized, revokedRefresh.StatusCode);
    }

    [Fact]
    public async Task APairingCodeCanBeExchangedOnlyOnce()
    {
        await using var factory = new TestApplicationFactory();
        using var local = CreateAuthenticatedClient(factory, factory.Token);
        var pairing = await CreatePairingAsync(local, "phase7-pairing-once");
        var first = await ExchangeAsync(local, pairing.Code);
        Assert.NotEqual(Guid.Empty, first.SessionId);

        using var second = await local.PostAsJsonAsync(
            "/api/v1/mobile-pairings/exchange",
            new MobilePairingExchangeRequest(pairing.Code));
        Assert.Equal(HttpStatusCode.Unauthorized, second.StatusCode);
    }

    [Fact]
    public async Task ConcurrentPairingExchangeReturnsAtMostOneSessionWithoutA500()
    {
        await using var factory = new TestApplicationFactory();
        using var local = CreateAuthenticatedClient(factory, factory.Token);
        var pairing = await CreatePairingAsync(local, "phase7-pairing-concurrent-exchange");

        var responses = await Task.WhenAll(
            local.PostAsJsonAsync(
                "/api/v1/mobile-pairings/exchange",
                new MobilePairingExchangeRequest(pairing.Code, "Phone A", "ios", ["microphone"])),
            local.PostAsJsonAsync(
                "/api/v1/mobile-pairings/exchange",
                new MobilePairingExchangeRequest(pairing.Code, "Phone B", "ios", ["microphone"])));

        Assert.Single(responses, response => response.StatusCode == HttpStatusCode.OK);
        Assert.Single(responses, response => response.StatusCode == HttpStatusCode.Unauthorized);
        Assert.DoesNotContain(responses, response => response.StatusCode == HttpStatusCode.InternalServerError);
    }

    [Fact]
    public async Task ConcurrentRefreshWithTheSameTokenReturnsAtMostOneRotationWithoutA500()
    {
        await using var factory = new TestApplicationFactory();
        using var local = CreateAuthenticatedClient(factory, factory.Token);
        var pairing = await CreatePairingAsync(local, "phase7-pairing-concurrent-refresh");
        var session = await ExchangeAsync(local, pairing.Code);

        var responses = await Task.WhenAll(
            local.PostAsJsonAsync(
                "/api/v1/mobile-sessions/refresh",
                new MobileSessionRefreshRequest(session.SessionId, session.RefreshToken)),
            local.PostAsJsonAsync(
                "/api/v1/mobile-sessions/refresh",
                new MobileSessionRefreshRequest(session.SessionId, session.RefreshToken)));

        Assert.Single(responses, response => response.StatusCode == HttpStatusCode.OK);
        Assert.Single(responses, response => response.StatusCode == HttpStatusCode.Unauthorized);
        Assert.DoesNotContain(responses, response => response.StatusCode == HttpStatusCode.InternalServerError);
    }

    [Fact]
    public async Task RevokeAndRefreshRaceNeverAllowsRefreshAfterRevocation()
    {
        await using var factory = new TestApplicationFactory();
        using var local = CreateAuthenticatedClient(factory, factory.Token);
        var pairing = await CreatePairingAsync(local, "phase7-pairing-revoke-refresh-race");
        var session = await ExchangeAsync(local, pairing.Code);
        using var mobile = CreateAuthenticatedClient(factory, session.AccessToken);

        var revokeTask = mobile.PostAsync("/api/v1/mobile-sessions/revoke", content: null);
        var refreshTask = local.PostAsJsonAsync(
            "/api/v1/mobile-sessions/refresh",
            new MobileSessionRefreshRequest(session.SessionId, session.RefreshToken));
        await Task.WhenAll(revokeTask, refreshTask);
        using var revoke = await revokeTask;
        using var refresh = await refreshTask;

        Assert.Contains(revoke.StatusCode, new[] { HttpStatusCode.OK, HttpStatusCode.Unauthorized });
        Assert.Contains(refresh.StatusCode, new[] { HttpStatusCode.OK, HttpStatusCode.Unauthorized });
        Assert.DoesNotContain(
            new[] { revoke.StatusCode, refresh.StatusCode },
            status => status == HttpStatusCode.InternalServerError);

        var rotated = refresh.StatusCode == HttpStatusCode.OK
            ? await refresh.Content.ReadFromJsonAsync<MobileSessionResponse>()
            : null;
        var refreshToken = rotated?.RefreshToken ?? session.RefreshToken;
        using var afterRevoke = await local.PostAsJsonAsync(
            "/api/v1/mobile-sessions/refresh",
            new MobileSessionRefreshRequest(session.SessionId, refreshToken));
        Assert.Equal(HttpStatusCode.Unauthorized, afterRevoke.StatusCode);
    }

    [Fact]
    public async Task RevokeReportsUnavailableWhenSqliteRemainsLockedAndCanBeRetried()
    {
        var databasePath = Path.Combine(Path.GetTempPath(), $"jarvis-mobile-revoke-lock-{Guid.NewGuid():N}.db");
        await using var factory = new TestApplicationFactory(databasePath, true, null);
        using var local = CreateAuthenticatedClient(factory, factory.Token);
        var pairing = await CreatePairingAsync(local, "phase7-pairing-revoke-lock");
        var session = await ExchangeAsync(local, pairing.Code);
        using var mobile = CreateAuthenticatedClient(factory, session.AccessToken);

        await using var lockConnection = new SqliteConnection($"Data Source={databasePath}");
        await lockConnection.OpenAsync();
        await using var lockTransaction = await lockConnection.BeginTransactionAsync(IsolationLevel.Serializable);
        await using (var lockCommand = lockConnection.CreateCommand())
        {
            lockCommand.Transaction = (SqliteTransaction)lockTransaction;
            lockCommand.CommandText = "UPDATE MobileSessions SET Version = Version WHERE Id = $sessionId";
            lockCommand.Parameters.AddWithValue("$sessionId", session.SessionId.ToString());
            await lockCommand.ExecuteNonQueryAsync();
        }

        using var lockedRevoke = await mobile.PostAsync("/api/v1/mobile-sessions/revoke", content: null);
        Assert.Equal(HttpStatusCode.ServiceUnavailable, lockedRevoke.StatusCode);

        await lockTransaction.RollbackAsync();
        using var stillActiveAccess = await mobile.GetAsync("/api/v1/devices");
        Assert.Equal(HttpStatusCode.OK, stillActiveAccess.StatusCode);
        using var stillActiveRefresh = await local.PostAsJsonAsync(
            "/api/v1/mobile-sessions/refresh",
            new MobileSessionRefreshRequest(session.SessionId, session.RefreshToken));
        Assert.Equal(HttpStatusCode.OK, stillActiveRefresh.StatusCode);
        var rotated = (await stillActiveRefresh.Content.ReadFromJsonAsync<MobileSessionResponse>())!;
        using var rotatedMobile = CreateAuthenticatedClient(factory, rotated.AccessToken);

        using var retryRevoke = await rotatedMobile.PostAsync("/api/v1/mobile-sessions/revoke", content: null);
        Assert.Equal(HttpStatusCode.OK, retryRevoke.StatusCode);
        using var revokedAccess = await rotatedMobile.GetAsync("/api/v1/devices");
        Assert.Equal(HttpStatusCode.Unauthorized, revokedAccess.StatusCode);
        using var revokedRefresh = await local.PostAsJsonAsync(
            "/api/v1/mobile-sessions/refresh",
            new MobileSessionRefreshRequest(rotated.SessionId, rotated.RefreshToken));
        Assert.Equal(HttpStatusCode.Unauthorized, revokedRefresh.StatusCode);
    }

    [Fact]
    public async Task MobileDeviceUsesRealtimeBootstrapButServerAndDisabledDevicesAreRejected()
    {
        var provider = new TestRealtimeClientSecretProvider();
        await using var factory = new TestApplicationFactory(
            databasePath: null,
            deleteDatabaseOnDispose: true,
            outboxPublisher: null,
            realtimeProvider: provider);
        using var local = CreateAuthenticatedClient(factory, factory.Token);
        var pairing = await CreatePairingAsync(local, "phase7-realtime-pairing");
        var session = await ExchangeAsync(local, pairing.Code);
        var conversation = await CreateConversationAsync(local, "phase7-realtime-conversation");
        using var mobile = CreateAuthenticatedClient(factory, session.AccessToken);

        using var bootstrap = new HttpRequestMessage(HttpMethod.Post, "/api/v1/realtime/client-secrets")
        {
            Content = JsonContent.Create(new RealtimeClientSecretRequest(conversation.Id, session.DeviceId))
        };
        bootstrap.Headers.Add("Idempotency-Key", "phase7-mobile-realtime");
        using var accepted = await mobile.SendAsync(bootstrap);
        Assert.Equal(HttpStatusCode.OK, accepted.StatusCode);
        Assert.NotNull(provider.LastRequest);
        Assert.NotEqual(Guid.Empty, provider.LastRequest!.UserId);
        Assert.Contains("Jarvis", provider.LastRequest.Context.Instructions, StringComparison.Ordinal);
        var realtime = (await accepted.Content.ReadFromJsonAsync<RealtimeClientSecretResponse>())!;
        Assert.Null(realtime.WakeWord);

        using (var connected = new HttpRequestMessage(
            HttpMethod.Post,
            $"/api/v1/realtime/sessions/{realtime.RealtimeSessionId:D}/connected")
        {
            Content = JsonContent.Create(new RealtimeSessionConnectedRequest("mobile-native-session"))
        })
        {
            connected.Headers.Add("Idempotency-Key", "phase7-mobile-realtime-connected");
            using var connectedResponse = await mobile.SendAsync(connected);
            Assert.Equal(HttpStatusCode.OK, connectedResponse.StatusCode);
        }

        using (var ingest = new HttpRequestMessage(
            HttpMethod.Post,
            $"/api/v1/conversations/{conversation.Id:D}/realtime-events:ingest")
        {
            Content = JsonContent.Create(new RealtimeEventsIngestRequest(
                1,
                [new RealtimeNormalizedEvent(
                    "mobile-event-1",
                    "mobile-item-1",
                    realtime.RealtimeSessionId,
                    MessageRoleValue.User,
                    "voice",
                    RealtimeEventStatusValue.Completed,
                    "hello from mobile")]))
        })
        {
            ingest.Headers.Add("Idempotency-Key", "phase7-mobile-realtime-ingest");
            using var ingestResponse = await mobile.SendAsync(ingest);
            Assert.Equal(HttpStatusCode.OK, ingestResponse.StatusCode);
        }

        using (var ended = new HttpRequestMessage(
            HttpMethod.Post,
            $"/api/v1/realtime/sessions/{realtime.RealtimeSessionId:D}/ended")
        {
            Content = JsonContent.Create(new RealtimeSessionEndedRequest(
                "mobile-test-complete",
                RealtimeSessionStatusValue.Disconnected))
        })
        {
            ended.Headers.Add("Idempotency-Key", "phase7-mobile-realtime-ended");
            using var endedResponse = await mobile.SendAsync(ended);
            Assert.Equal(HttpStatusCode.OK, endedResponse.StatusCode);
        }

        await using (var connection = new HubConnectionBuilder()
            .WithUrl(
                new Uri(factory.Server.BaseAddress, "/hubs/client"),
                options =>
                {
                    options.HttpMessageHandlerFactory = _ => factory.Server.CreateHandler();
                    options.AccessTokenProvider = () => Task.FromResult<string?>(session.AccessToken);
                })
            .Build())
        {
            await connection.StartAsync();
            Assert.Equal(HubConnectionState.Connected, connection.State);
            await connection.StopAsync();
        }

        DeviceRegistrationResponse server;
        using (var register = new HttpRequestMessage(HttpMethod.Post, "/api/v1/devices/register")
        {
            Content = JsonContent.Create(new DeviceRegistrationRequest("Server", DeviceTypeValue.Server, "linux", []))
        })
        {
            register.Headers.Add("Idempotency-Key", "phase7-server-register");
            using var registered = await local.SendAsync(register);
            Assert.Equal(HttpStatusCode.Created, registered.StatusCode);
            server = (await registered.Content.ReadFromJsonAsync<DeviceRegistrationResponse>())!;
        }

        using (var rejectedServer = new HttpRequestMessage(HttpMethod.Post, "/api/v1/realtime/client-secrets")
        {
            Content = JsonContent.Create(new RealtimeClientSecretRequest(conversation.Id, server.DeviceId))
        })
        {
            rejectedServer.Headers.Add("Idempotency-Key", "phase7-server-realtime");
            using var response = await mobile.SendAsync(rejectedServer);
            Assert.Equal(HttpStatusCode.NotFound, response.StatusCode);
        }

        await using (var scope = factory.Services.CreateAsyncScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<Jarvis.Infrastructure.Data.JarvisDbContext>();
            var device = await db.Devices.SingleAsync(item => item.Id == session.DeviceId);
            device.Disable(DateTimeOffset.UtcNow.ToUnixTimeMilliseconds());
            await db.SaveChangesAsync();
        }

        using var rejectedDisabled = new HttpRequestMessage(HttpMethod.Post, "/api/v1/realtime/client-secrets")
        {
            Content = JsonContent.Create(new RealtimeClientSecretRequest(conversation.Id, session.DeviceId))
        };
        rejectedDisabled.Headers.Add("Idempotency-Key", "phase7-disabled-realtime");
        using var disabledResponse = await mobile.SendAsync(rejectedDisabled);
        Assert.Equal(HttpStatusCode.NotFound, disabledResponse.StatusCode);
    }

    private static HttpClient CreateAuthenticatedClient(TestApplicationFactory factory, string token)
    {
        var client = factory.CreateClient();
        client.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", token);
        return client;
    }

    private static async Task<MobilePairingResponse> CreatePairingAsync(HttpClient client, string key)
    {
        using var request = new HttpRequestMessage(HttpMethod.Post, "/api/v1/mobile-pairings")
        {
            Content = JsonContent.Create(new MobilePairingRequest("Phone", "ios"))
        };
        request.Headers.Add("Idempotency-Key", key);
        using var response = await client.SendAsync(request);
        Assert.Equal(HttpStatusCode.Created, response.StatusCode);
        return (await response.Content.ReadFromJsonAsync<MobilePairingResponse>())!;
    }

    private static async Task<MobileSessionResponse> ExchangeAsync(HttpClient client, string code)
    {
        using var response = await client.PostAsJsonAsync(
            "/api/v1/mobile-pairings/exchange",
            new MobilePairingExchangeRequest(code));
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        return (await response.Content.ReadFromJsonAsync<MobileSessionResponse>())!;
    }

    private static async Task<ConversationResponse> CreateConversationAsync(HttpClient client, string key)
    {
        using var request = new HttpRequestMessage(HttpMethod.Post, "/api/v1/conversations")
        {
            Content = JsonContent.Create(new CreateConversationRequest("Mobile"))
        };
        request.Headers.Add("Idempotency-Key", key);
        using var response = await client.SendAsync(request);
        Assert.Equal(HttpStatusCode.Created, response.StatusCode);
        return (await response.Content.ReadFromJsonAsync<ConversationResponse>())!;
    }

    private sealed class TestRealtimeClientSecretProvider : IRealtimeClientSecretProvider
    {
        public RealtimeClientSecretProviderRequest? LastRequest { get; private set; }

        public Task<RealtimeClientSecretProviderResponse> CreateAsync(
            RealtimeClientSecretProviderRequest request,
            CancellationToken cancellationToken)
        {
            LastRequest = request;
            return Task.FromResult(new RealtimeClientSecretProviderResponse(
                "ephemeral-test-secret",
                DateTimeOffset.UtcNow.AddMinutes(5).ToUnixTimeMilliseconds(),
                "external-session",
                "gpt-4o-realtime-preview",
                "alloy",
                "https://api.openai.test/v1/realtime/calls"));
        }
    }
}
