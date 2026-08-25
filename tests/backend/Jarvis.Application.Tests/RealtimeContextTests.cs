using Jarvis.Application.Realtime;
using Xunit;

namespace Jarvis.Application.Tests;

public sealed class RealtimeContextTests
{
    [Fact]
    public void KeepsFixedSafetyInstructionsAndIndependentBudgets()
    {
        var assembler = new ContextAssembler();
        var package = assembler.Assemble(new ContextAssemblyInput(
            12,
            "FIXED SAFETY RULES",
            new string('p', 4_500),
            new string('s', 9_000),
            [
                new ContextMessage("user", "old"),
                new ContextMessage("assistant", new string('n', 25_000)),
                new ContextMessage("user", "new")
            ],
            new string('t', 7_000),
            new string('m', 7_000)));

        Assert.Equal(12, package.ContextVersion);
        Assert.Equal("FIXED SAFETY RULES", package.Instructions);
        Assert.True(ContextAssembler.EstimateTokens(package.UserPreferences) <= ContextAssembler.UserPreferencesBudget);
        Assert.True(ContextAssembler.EstimateTokens(package.Summary) <= ContextAssembler.SummaryBudget);
        Assert.True(ContextAssembler.EstimateTokens(package.TasksAndResults) <= ContextAssembler.TasksAndResultsBudget);
        Assert.True(ContextAssembler.EstimateTokens(package.MemoryFacts) <= ContextAssembler.MemoryFactsBudget);
        Assert.True(package.RecentMessages.Count <= 2);
        Assert.Equal("new", package.RecentMessages[^1].Text);
        Assert.DoesNotContain(package.RecentMessages, message => message.Text == "old");
    }

    [Fact]
    public void SafetyIdentifierIsStableBoundedAndDoesNotContainRawUserId()
    {
        var userId = Guid.Parse("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa");
        var first = SafetyIdentifier.Create(userId, "salt");
        var second = SafetyIdentifier.Create(userId, "salt");

        Assert.Equal(first, second);
        Assert.InRange(first.Length, 1, 64);
        Assert.DoesNotContain(userId.ToString("D"), first, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public void AConflictingPayloadDoesNotEvictTheOriginalEphemeralReplay()
    {
        var cache = new EphemeralSecretReplayCache();
        var userId = Guid.NewGuid();
        var response = new Jarvis.Contracts.RealtimeClientSecretResponse(
            Guid.NewGuid(),
            Guid.NewGuid(),
            Guid.NewGuid(),
            "instructions",
            "ek_ephemeral",
            2_000,
            "model",
            "voice",
            1,
            1_500);
        cache.Set(userId, "same-key", "original-hash", response);

        Assert.False(cache.TryGet(userId, "same-key", "different-hash", 1_000, out _));
        Assert.True(cache.TryGet(userId, "same-key", "original-hash", 1_000, out var replay));
        Assert.Equal(response.ClientSecret, replay.ClientSecret);
    }

    [Fact]
    public async Task SingleFlightNeverRunsTwoLeasesForOneKeyAcrossEntryRemoval()
    {
        var singleFlight = new RealtimeClientSecretSingleFlight();
        var active = 0;
        var maximumActive = 0;
        var start = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var workers = Enumerable.Range(0, 64).Select(async _ =>
        {
            await start.Task;
            for (var round = 0; round < 12; round++)
            {
                await using var lease = await singleFlight.AcquireAsync(
                    Guid.Parse("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"),
                    "same-key",
                    CancellationToken.None);
                var current = Interlocked.Increment(ref active);
                InterlockedMax(ref maximumActive, current);
                await Task.Delay(1);
                Interlocked.Decrement(ref active);
            }
        }).ToArray();

        start.SetResult();
        await Task.WhenAll(workers);

        Assert.Equal(1, maximumActive);
    }

    private static void InterlockedMax(ref int target, int value)
    {
        while (true)
        {
            var snapshot = Volatile.Read(ref target);
            if (snapshot >= value || Interlocked.CompareExchange(ref target, value, snapshot) == snapshot)
            {
                return;
            }
        }
    }
}
