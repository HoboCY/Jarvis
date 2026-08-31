using Jarvis.Application.Responses;
using Jarvis.Infrastructure.Responses;
using Microsoft.Extensions.Options;
using Xunit;

namespace Jarvis.Infrastructure.Tests;

public sealed class ResponsesSummaryProviderTests
{
    [Fact]
    public async Task SynchronousResultUsesTheConfiguredSummarizerModelWithoutPolling()
    {
        var runtime = new SynchronousRuntime();
        var provider = new ResponsesSummaryProvider(
            runtime,
            Options.Create(new ResponsesOptions
            {
                SummarizerModel = "deepseek-v4-flash",
                PollingIntervalMs = 25
            }));

        var result = await provider.SummarizeAsync(
            new SummaryRequest(
                Guid.Parse("00000000-0000-7000-8000-000000000001"),
                1,
                1,
                [new SummaryInputMessage("User", "hello", 1)]),
            CancellationToken.None);

        Assert.Equal("同步摘要", result);
        Assert.Equal("deepseek-v4-flash", runtime.Request.Model);
        Assert.False(runtime.Request.Background);
        Assert.True(runtime.Request.Store);
    }

    private sealed class SynchronousRuntime : IResponsesRuntime
    {
        public ResponsesCreateRequest Request { get; private set; } = null!;

        public Task<ResponsesResult> CreateAsync(ResponsesCreateRequest request, CancellationToken cancellationToken)
        {
            Request = request;
            return Task.FromResult(new ResponsesResult("summary-1", ResponsesStatus.Completed, "同步摘要"));
        }
    }
}
