using Jarvis.Application.Devices;
using Jarvis.DeviceNode.Codex;
using Jarvis.Infrastructure.Budgets;
using Xunit;

namespace Jarvis.DeviceNode.Tests;

public sealed class CodexProcessSupervisorBudgetTests
{
    [Fact]
    public async Task ReservesOneTaskAndOneRetryForTheSameLogicalTask()
    {
        var taskId = Guid.NewGuid();
        var admission = new RecordingAdmission();
        var runtimes = new Queue<ICodexRuntime>([
            new FailingRuntime(),
            new SuccessfulRuntime()]);
        var supervisor = new CodexProcessSupervisor(
            _ => Task.FromResult(runtimes.Dequeue()),
            new CodexSupervisorOptions(MaxRestartAttempts: 1, RestartDelay: TimeSpan.Zero),
            admission);

        await supervisor.RunAsync(
            CapabilityPolicy.Create(new CapabilityEnvelope()),
            cwd: null,
            existingThreadId: null,
            execute: async (runtime, threadId, cancellationToken) =>
            {
                await runtime.StartTurnAsync(threadId, "bounded", cancellationToken);
                return true;
            },
            logicalTaskId: taskId);

        Assert.Equal(
            ["codexTasks", "retries"],
            admission.Reservations.Select(item => item.Kind));
        Assert.All(admission.Reservations, item => Assert.Equal(taskId, item.LogicalId));
        Assert.Equal($"codex:{taskId:D}", admission.Reservations[0].RequestKey);
        Assert.Matches($"^retry:{taskId:D}:[0-9a-f]{{32}}:restart:1$", admission.Reservations[1].RequestKey);
    }

    [Fact]
    public async Task RejectedTaskReservationPreventsRuntimeLaunch()
    {
        var admission = new RecordingAdmission
        {
            Failure = new Phase9bBudgetAdmissionException("BUDGET_EXHAUSTED")
        };
        var runtimeFactoryCalls = 0;
        var supervisor = new CodexProcessSupervisor(
            _ =>
            {
                runtimeFactoryCalls++;
                return Task.FromResult<ICodexRuntime>(new SuccessfulRuntime());
            },
            new CodexSupervisorOptions(MaxRestartAttempts: 1),
            admission);

        await Assert.ThrowsAsync<Phase9bBudgetAdmissionException>(() => supervisor.RunAsync(
            CapabilityPolicy.Create(new CapabilityEnvelope()),
            cwd: null,
            existingThreadId: null,
            execute: (_, _, _) => Task.FromResult(true),
            logicalTaskId: Guid.NewGuid()));

        Assert.Equal(0, runtimeFactoryCalls);
        var reservation = Assert.Single(admission.Reservations);
        Assert.Equal("codexTasks", reservation.Kind);
    }

    [Fact]
    public async Task EnabledAdmissionRequiresTheLogicalTaskIdBeforeLaunchingRuntime()
    {
        var admission = new RecordingAdmission();
        var runtimeFactoryCalls = 0;
        var supervisor = new CodexProcessSupervisor(
            _ =>
            {
                runtimeFactoryCalls++;
                return Task.FromResult<ICodexRuntime>(new SuccessfulRuntime());
            },
            budgetAdmission: admission);

        var exception = await Assert.ThrowsAsync<Phase9bBudgetAdmissionException>(() => supervisor.RunAsync(
            CapabilityPolicy.Create(new CapabilityEnvelope()),
            cwd: null,
            existingThreadId: null,
            execute: (_, _, _) => Task.FromResult(true)));

        Assert.Equal("ADMISSION_INVALID", exception.Code);
        Assert.Equal(0, runtimeFactoryCalls);
        Assert.Empty(admission.Reservations);
    }

    [Fact]
    public async Task SameTaskReplayKeepsTaskReservationIdempotentAndUsesFreshRetryKeys()
    {
        var taskId = Guid.NewGuid();
        var admission = new RecordingAdmission();
        var runtimeFactory = new RuntimeFactory();

        CodexProcessSupervisor CreateSupervisor(RecordingAdmission budgetAdmission) => new(
            runtimeFactory,
            new CodexSupervisorOptions(MaxRestartAttempts: 1, RestartDelay: TimeSpan.Zero),
            budgetAdmission);

        await CreateSupervisor(admission).RunAsync(
            CapabilityPolicy.Create(new CapabilityEnvelope()),
            cwd: null,
            existingThreadId: null,
            execute: async (runtime, threadId, cancellationToken) =>
            {
                await runtime.StartTurnAsync(threadId, "bounded", cancellationToken);
                return true;
            },
            logicalTaskId: taskId);
        await CreateSupervisor(admission).RunAsync(
            CapabilityPolicy.Create(new CapabilityEnvelope()),
            cwd: null,
            existingThreadId: null,
            execute: async (runtime, threadId, cancellationToken) =>
            {
                await runtime.StartTurnAsync(threadId, "bounded", cancellationToken);
                return true;
            },
            logicalTaskId: taskId);

        Assert.Equal(
            ["codexTasks", "retries", "codexTasks", "retries"],
            admission.Reservations.Select(item => item.Kind));
        Assert.Equal(admission.Reservations[0].RequestKey, admission.Reservations[2].RequestKey);
        Assert.NotEqual(admission.Reservations[1].RequestKey, admission.Reservations[3].RequestKey);
    }

    [Fact]
    public async Task ReplayedTaskReservationConsumesRetryBeforeLaunchingAnotherRuntime()
    {
        var taskId = Guid.NewGuid();
        var admission = new RecordingAdmission
        {
            Failure = new Phase9bBudgetAdmissionException("BUDGET_EXHAUSTED"),
            FailureKind = "retries"
        };
        var runtimeFactoryCalls = 0;
        var firstSupervisor = new CodexProcessSupervisor(
            _ =>
            {
                runtimeFactoryCalls++;
                return Task.FromResult<ICodexRuntime>(new SuccessfulRuntime());
            },
            budgetAdmission: admission);

        await firstSupervisor.RunAsync(
            CapabilityPolicy.Create(new CapabilityEnvelope()),
            cwd: null,
            existingThreadId: null,
            execute: (_, _, _) => Task.FromResult(true),
            logicalTaskId: taskId);

        var secondSupervisor = new CodexProcessSupervisor(
            _ =>
            {
                runtimeFactoryCalls++;
                return Task.FromResult<ICodexRuntime>(new SuccessfulRuntime());
            },
            budgetAdmission: admission);

        await Assert.ThrowsAsync<Phase9bBudgetAdmissionException>(() => secondSupervisor.RunAsync(
            CapabilityPolicy.Create(new CapabilityEnvelope()),
            cwd: null,
            existingThreadId: null,
            execute: (_, _, _) => Task.FromResult(true),
            logicalTaskId: taskId));

        Assert.Equal(1, runtimeFactoryCalls);
        Assert.Equal(["codexTasks", "codexTasks", "retries"], admission.Reservations.Select(item => item.Kind));
    }

    [Fact]
    public async Task ReplayedTakeoverFailureConsumesAnotherRetryBeforeLaunchingThirdRuntime()
    {
        var taskId = Guid.NewGuid();
        var admission = new RecordingAdmission
        {
            Failure = new Phase9bBudgetAdmissionException("BUDGET_EXHAUSTED"),
            FailureKind = "retries",
            FailureAtUniqueKindReservationNumber = 2
        };
        var runtimes = new Queue<ICodexRuntime>([
            new SuccessfulRuntime(),
            new FailingRuntime(),
            new SuccessfulRuntime()]);
        var runtimeFactoryCalls = 0;

        CodexProcessSupervisor CreateSupervisor() => new(
            _ =>
            {
                runtimeFactoryCalls++;
                return Task.FromResult(runtimes.Dequeue());
            },
            new CodexSupervisorOptions(MaxRestartAttempts: 1, RestartDelay: TimeSpan.Zero),
            admission);

        await CreateSupervisor().RunAsync(
            CapabilityPolicy.Create(new CapabilityEnvelope()),
            cwd: null,
            existingThreadId: null,
            execute: async (runtime, threadId, cancellationToken) =>
            {
                await runtime.StartTurnAsync(threadId, "bounded", cancellationToken);
                return true;
            },
            logicalTaskId: taskId);

        await Assert.ThrowsAsync<Phase9bBudgetAdmissionException>(() => CreateSupervisor().RunAsync(
            CapabilityPolicy.Create(new CapabilityEnvelope()),
            cwd: null,
            existingThreadId: null,
            execute: async (runtime, threadId, cancellationToken) =>
            {
                await runtime.StartTurnAsync(threadId, "bounded", cancellationToken);
                return true;
            },
            logicalTaskId: taskId));

        Assert.Equal(2, runtimeFactoryCalls);
        var retries = admission.Reservations.Where(item => item.Kind == "retries").ToArray();
        Assert.Equal(2, retries.Length);
        Assert.NotEqual(retries[0].RequestKey, retries[1].RequestKey);
        Assert.EndsWith(":takeover", retries[0].RequestKey, StringComparison.Ordinal);
        Assert.EndsWith(":restart:1", retries[1].RequestKey, StringComparison.Ordinal);
    }

    private sealed class RuntimeFactory
    {
        private int count;

        public static implicit operator Func<CancellationToken, Task<ICodexRuntime>>(RuntimeFactory factory) =>
            factory.Create;

        private Task<ICodexRuntime> Create(CancellationToken cancellationToken) =>
            Task.FromResult<ICodexRuntime>(Interlocked.Increment(ref count) == 1
                ? new FailingRuntime()
                : new SuccessfulRuntime());
    }

    private sealed class RecordingAdmission : IPhase9bBudgetAdmission
    {
        public List<Reservation> Reservations { get; } = [];

        public Phase9bBudgetAdmissionException? Failure { get; init; }

        public string? FailureKind { get; init; }

        public int? FailureAtUniqueKindReservationNumber { get; init; }

        public bool Enabled => true;

        public Task<Phase9bBudgetReservation> ReserveAsync(
            string kind,
            Guid logicalId,
            string requestKey,
            CancellationToken cancellationToken)
        {
            var replayed = Reservations.Any(item => item.Kind == kind && item.LogicalId == logicalId);
            Reservations.Add(new Reservation(kind, logicalId, requestKey));
            var uniqueKindReservationNumber = Reservations
                .Where(item => item.Kind == kind)
                .Select(item => item.RequestKey)
                .Distinct(StringComparer.Ordinal)
                .Count();
            if (Failure is not null &&
                (FailureKind is null || FailureKind == kind) &&
                (FailureAtUniqueKindReservationNumber is null ||
                    uniqueKindReservationNumber >= FailureAtUniqueKindReservationNumber))
            {
                return Task.FromException<Phase9bBudgetReservation>(Failure);
            }

            return Task.FromResult(new Phase9bBudgetReservation(
                kind,
                logicalId,
                Guid.NewGuid().ToString("D"),
                Replayed: replayed,
                Remaining: 1));
        }
    }

    private sealed record Reservation(string Kind, Guid LogicalId, string RequestKey);

    private sealed class FailingRuntime : TestRuntime
    {
        public override Task<CodexTurnHandle> StartTurnAsync(
            string threadId,
            string input,
            CancellationToken cancellationToken = default) =>
            Task.FromException<CodexTurnHandle>(new InvalidOperationException("fixture failure"));
    }

    private sealed class SuccessfulRuntime : TestRuntime
    {
    }

    private abstract class TestRuntime : ICodexRuntime
    {
        public Task InitializeAsync(CancellationToken cancellationToken = default) => Task.CompletedTask;

        public Task<CodexThreadHandle> StartThreadAsync(
            CapabilityPolicy policy,
            string? cwd,
            CancellationToken cancellationToken = default) =>
            Task.FromResult(new CodexThreadHandle(
                "thread-fixture",
                System.Text.Json.JsonSerializer.SerializeToElement(new { })));

        public Task<CodexThreadHandle> ResumeThreadAsync(
            string threadId,
            CapabilityPolicy policy,
            string? cwd,
            CancellationToken cancellationToken = default) =>
            StartThreadAsync(policy, cwd, cancellationToken);

        public virtual Task<CodexTurnHandle> StartTurnAsync(
            string threadId,
            string input,
            CancellationToken cancellationToken = default) =>
            Task.FromResult(new CodexTurnHandle(
                threadId,
                "turn-fixture",
                System.Text.Json.JsonSerializer.SerializeToElement(new { })));

        public Task InterruptTurnAsync(string threadId, string turnId, CancellationToken cancellationToken = default) =>
            Task.CompletedTask;

        public async IAsyncEnumerable<CodexRuntimeEvent> ReadEventsAsync(
            [System.Runtime.CompilerServices.EnumeratorCancellation] CancellationToken cancellationToken = default)
        {
            await Task.CompletedTask;
            yield break;
        }

        public Task RespondToServerRequestAsync(
            CodexServerRequest request,
            object result,
            CancellationToken cancellationToken = default) => Task.CompletedTask;

        public string StderrSummary => string.Empty;

        public ValueTask DisposeAsync() => ValueTask.CompletedTask;
    }
}
