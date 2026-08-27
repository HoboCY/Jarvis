using Jarvis.DeviceNode;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Options;
using Xunit;

namespace Jarvis.DeviceNode.Tests;

public sealed class DeviceNodeRealtimeTests
{
    [Fact]
    public async Task DeviceHubHintsWakeAllCurrentPollersWithoutOwningTaskState()
    {
        var connection = new RecordingDeviceNodeHubConnection();
        var factory = new RecordingDeviceNodeHubConnectionFactory(connection);
        var wakeSignal = new DeviceNodeWakeSignal();
        var options = Options.Create(new DeviceNodeOptions
        {
            ApiBaseUrl = "https://jarvis.test/base/",
            DeviceId = Guid.NewGuid(),
            DeviceCredential = "device-credential",
            PollingIntervalMs = 25
        });
        var service = new DeviceNodeSignalRHostedService(
            options,
            factory,
            wakeSignal,
            NullLogger<DeviceNodeSignalRHostedService>.Instance);

        await service.StartAsync(CancellationToken.None);
        await connection.Started.Task.WaitAsync(TimeSpan.FromSeconds(1));

        Assert.Equal(new Uri("https://jarvis.test/hubs/device"), factory.HubUri);
        Assert.Equal("device-credential", factory.AccessToken);
        Assert.Equal(
            ["approval.resolved", "node.configurationChanged", "task.available", "task.cancellationRequested"],
            connection.Subscriptions.Keys.Order(StringComparer.Ordinal).ToArray());

        var firstPoller = wakeSignal.WaitAsync(TimeSpan.FromMinutes(1), CancellationToken.None);
        var secondPoller = wakeSignal.WaitAsync(TimeSpan.FromMinutes(1), CancellationToken.None);
        connection.Emit("task.available");
        await Task.WhenAll(firstPoller, secondPoller).WaitAsync(TimeSpan.FromSeconds(1));

        connection.Close();
        await WaitUntilAsync(() => connection.StartCalls == 2);

        await service.StopAsync(CancellationToken.None);
        Assert.Equal(1, connection.StopCalls);
        Assert.True(connection.Disposed);
    }

    [Fact]
    public async Task WakeSignalFallsBackToPollingWhenNoHintArrives()
    {
        var wakeSignal = new DeviceNodeWakeSignal();

        await wakeSignal.WaitAsync(TimeSpan.FromMilliseconds(25), CancellationToken.None)
            .WaitAsync(TimeSpan.FromSeconds(1));
    }

    private static async Task WaitUntilAsync(Func<bool> condition)
    {
        using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(1));
        while (!condition())
        {
            await Task.Delay(10, timeout.Token);
        }
    }

    private sealed class RecordingDeviceNodeHubConnectionFactory(
        RecordingDeviceNodeHubConnection connection) : IDeviceNodeHubConnectionFactory
    {
        public Uri? HubUri { get; private set; }
        public string? AccessToken { get; private set; }

        public IDeviceNodeHubConnection Create(Uri hubUri, string accessToken)
        {
            HubUri = hubUri;
            AccessToken = accessToken;
            return connection;
        }
    }

    private sealed class RecordingDeviceNodeHubConnection : IDeviceNodeHubConnection
    {
        private TaskCompletionSource closed = NewCompletionSource();

        public Dictionary<string, Action> Subscriptions { get; } = new(StringComparer.Ordinal);
        public TaskCompletionSource Started { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);
        public int StartCalls { get; private set; }
        public int StopCalls { get; private set; }
        public bool Disposed { get; private set; }

        public IDisposable Subscribe(string eventName, Action handler)
        {
            Subscriptions.Add(eventName, handler);
            return new NoopDisposable();
        }

        public Task StartAsync(CancellationToken cancellationToken)
        {
            StartCalls++;
            closed = NewCompletionSource();
            Started.TrySetResult();
            return Task.CompletedTask;
        }

        public Task WaitForClosedAsync(CancellationToken cancellationToken) =>
            closed.Task.WaitAsync(cancellationToken);

        public Task StopAsync(CancellationToken cancellationToken)
        {
            StopCalls++;
            closed.TrySetResult();
            return Task.CompletedTask;
        }

        public ValueTask DisposeAsync()
        {
            Disposed = true;
            return ValueTask.CompletedTask;
        }

        public void Emit(string eventName) => Subscriptions[eventName]();

        public void Close() => closed.TrySetResult();

        private static TaskCompletionSource NewCompletionSource() =>
            new(TaskCreationOptions.RunContinuationsAsynchronously);

        private sealed class NoopDisposable : IDisposable
        {
            public void Dispose()
            {
            }
        }
    }
}
