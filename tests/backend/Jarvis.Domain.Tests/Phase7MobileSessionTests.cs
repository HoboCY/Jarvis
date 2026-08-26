using System.Security.Cryptography;
using System.Text;
using Jarvis.Domain.Mobile;
using Xunit;

namespace Jarvis.Domain.Tests;

public sealed class Phase7MobileSessionTests
{
    [Fact]
    public void PairingIsSingleUseAndExpiresAtTheBoundary()
    {
        var pairing = MobilePairing.Create(
            Guid.NewGuid(),
            Guid.NewGuid(),
            "hash",
            "Phone",
            "ios",
            "[]",
            createdAtMs: 100,
            expiresAtMs: 200);

        Assert.True(pairing.TryConsume(199));
        Assert.False(pairing.TryConsume(199));
        Assert.Equal(199, pairing.ConsumedAtMs);

        var expired = MobilePairing.Create(
            Guid.NewGuid(),
            Guid.NewGuid(),
            "hash",
            "Phone",
            "ios",
            "[]",
            createdAtMs: 100,
            expiresAtMs: 200);
        Assert.False(expired.TryConsume(200));
    }

    [Fact]
    public void RefreshRequiresCurrentHashRotatesAndRevokeIsTerminal()
    {
        var oldHash = Hash("old-refresh");
        var session = MobileSession.Create(
            Guid.NewGuid(),
            Guid.NewGuid(),
            Guid.NewGuid(),
            oldHash,
            createdAtMs: 100,
            refreshTokenExpiresAtMs: 1_000);

        Assert.True(session.CanRefresh(500, Convert.FromHexString(oldHash)));
        Assert.False(session.CanRefresh(500, Convert.FromHexString(Hash("wrong-refresh"))));
        Assert.True(session.RotateRefreshToken(Hash("new-refresh"), 500, 1_500));
        Assert.False(session.CanRefresh(500, Convert.FromHexString(oldHash)));
        Assert.True(session.CanRefresh(1_000, Convert.FromHexString(Hash("new-refresh"))));

        Assert.True(session.Revoke(1_100));
        Assert.False(session.Revoke(1_101));
        Assert.False(session.CanRefresh(1_200, Convert.FromHexString(Hash("new-refresh"))));
    }

    private static string Hash(string value) => Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(value)));
}
