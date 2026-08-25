using System.Text.Json;
using Jarvis.Application.Tasks;
using Microsoft.Extensions.Options;

namespace Jarvis.Infrastructure.Tasks;

public sealed class FakeDelayAdapter(
    IOptions<FakeDelayOptions> options) : IFakeDelayAdapter
{
    public async Task<FakeWorkResult> ExecuteAsync(
        FakeWorkItem workItem,
        CancellationToken cancellationToken)
    {
        var delayMs = Math.Clamp(options.Value.DelayMs, 0, FakeDelayOptions.MaxDelayMs);
        if (delayMs > 0)
        {
            await Task.Delay(delayMs, cancellationToken);
        }

        var result = new
        {
            fake = true,
            taskId = workItem.TaskId,
            workerKind = workItem.WorkerKind.ToString(),
            goal = workItem.Goal,
            expectedOutput = workItem.ExpectedOutput
        };
        return new(
            true,
            $"Fake worker completed: {workItem.Goal}",
            JsonSerializer.Serialize(result));
    }
}
