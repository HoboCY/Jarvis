using Jarvis.Contracts;
using Microsoft.AspNetCore.SignalR.Client;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;

namespace Jarvis.DeviceNode;

public interface IDeviceNodeWakeSignal
{
    void Pulse();

    Task WaitAsync(TimeSpan pollingFallback, CancellationToken cancellationToken);
}

/// <summary>
/// Broadcasts a transient wake hint to current HTTP pollers. Missing a hint is safe because every
/// waiter retains a bounded polling fallback and always reads authoritative state over HTTP.
/// </summary>
public sealed class DeviceNodeWakeSignal(TimeProvider? timeProvider = null) : IDeviceNodeWakeSignal
{
    private readonly object gate = new();
    private readonly TimeProvider timeProvider = timeProvider ?? TimeProvider.System;
    private TaskCompletionSource pulse = CreatePulse();

    public void Pulse()
    {
        TaskCompletionSource current;
        lock (gate)
        {
            current = pulse;
            pulse = CreatePulse();
        }

        current.TrySetResult();
    }

    public async Task WaitAsync(TimeSpan pollingFallback, CancellationToken cancellationToken)
    {
        Task hint;
        lock (gate)
        {
            hint = pulse.Task;
        }

        using var fallbackCancellation = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        var fallback = Task.Delay(pollingFallback, timeProvider, fallbackCancellation.Token);
        var completed = await Task.WhenAny(hint, fallback).ConfigureAwait(false);
        if (ReferenceEquals(completed, hint))
        {
            await fallbackCancellation.CancelAsync().ConfigureAwait(false);
        }

        await completed.WaitAsync(cancellationToken).ConfigureAwait(false);
    }

    private static TaskCompletionSource CreatePulse() =>
        new(TaskCreationOptions.RunContinuationsAsynchronously);
}

public interface IDeviceNodeHubConnection : IAsyncDisposable
{
    IDisposable Subscribe(string eventName, Action handler);

    Task StartAsync(CancellationToken cancellationToken);

    Task WaitForClosedAsync(CancellationToken cancellationToken);

    Task StopAsync(CancellationToken cancellationToken);
}

public interface IDeviceNodeHubConnectionFactory
{
    IDeviceNodeHubConnection Create(Uri hubUri, string accessToken);
}

public sealed class SignalRDeviceNodeHubConnectionFactory : IDeviceNodeHubConnectionFactory
{
    public IDeviceNodeHubConnection Create(Uri hubUri, string accessToken)
    {
        var connection = new HubConnectionBuilder()
            .WithUrl(hubUri, options =>
                options.AccessTokenProvider = () => Task.FromResult<string?>(accessToken))
            .WithAutomaticReconnect()
            .Build();
        return new SignalRDeviceNodeHubConnection(connection);
    }
}

internal sealed class SignalRDeviceNodeHubConnection : IDeviceNodeHubConnection
{
    private readonly HubConnection connection;
    private TaskCompletionSource closed = CreateCompletionSource();

    public SignalRDeviceNodeHubConnection(HubConnection connection)
    {
        this.connection = connection;
        connection.Closed += _ =>
        {
            Volatile.Read(ref closed).TrySetResult();
            return Task.CompletedTask;
        };
    }

    public IDisposable Subscribe(string eventName, Action handler) =>
        connection.On<OutboxEventEnvelope>(eventName, _ => handler());

    public Task StartAsync(CancellationToken cancellationToken)
    {
        Interlocked.Exchange(ref closed, CreateCompletionSource());
        return connection.StartAsync(cancellationToken);
    }

    public Task WaitForClosedAsync(CancellationToken cancellationToken) =>
        Volatile.Read(ref closed).Task.WaitAsync(cancellationToken);

    public Task StopAsync(CancellationToken cancellationToken) =>
        connection.StopAsync(cancellationToken);

    public ValueTask DisposeAsync() => connection.DisposeAsync();

    private static TaskCompletionSource CreateCompletionSource() =>
        new(TaskCreationOptions.RunContinuationsAsynchronously);
}

public sealed partial class DeviceNodeSignalRHostedService(
    IOptions<DeviceNodeOptions> options,
    IDeviceNodeHubConnectionFactory connectionFactory,
    IDeviceNodeWakeSignal wakeSignal,
    ILogger<DeviceNodeSignalRHostedService> logger) : BackgroundService
{
    private static readonly string[] EventNames =
    [
        "task.available",
        "task.cancellationRequested",
        "approval.resolved",
        "node.configurationChanged"
    ];
    private readonly DeviceNodeOptions nodeOptions = options.Value;

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        if (nodeOptions.DeviceId == Guid.Empty || string.IsNullOrWhiteSpace(nodeOptions.DeviceCredential))
        {
            return;
        }

        var hubUri = new Uri(new Uri(nodeOptions.ApiBaseUrl, UriKind.Absolute), "/hubs/device");
        await using var connection = connectionFactory.Create(hubUri, nodeOptions.DeviceCredential);
        var subscriptions = EventNames
            .Select(eventName => connection.Subscribe(eventName, wakeSignal.Pulse))
            .ToArray();
        try
        {
            while (!stoppingToken.IsCancellationRequested)
            {
                try
                {
                    await connection.StartAsync(stoppingToken).ConfigureAwait(false);
                    await connection.WaitForClosedAsync(stoppingToken).ConfigureAwait(false);
                }
                catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
                {
                    break;
                }
                catch (Exception exception)
                {
                    LogConnectionFailure(logger, exception);
                }

                try
                {
                    await Task.Delay(
                        Math.Max(25, nodeOptions.PollingIntervalMs),
                        stoppingToken).ConfigureAwait(false);
                }
                catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
                {
                    break;
                }
            }
        }
        finally
        {
            foreach (var subscription in subscriptions)
            {
                subscription.Dispose();
            }

            try
            {
                await connection.StopAsync(CancellationToken.None).ConfigureAwait(false);
            }
            catch (Exception exception)
            {
                LogStopFailure(logger, exception);
            }
        }
    }

    [LoggerMessage(
        EventId = 7201,
        Level = LogLevel.Warning,
        Message = "Device Hub connection failed; HTTP polling remains active and SignalR will retry.")]
    private static partial void LogConnectionFailure(ILogger logger, Exception exception);

    [LoggerMessage(
        EventId = 7202,
        Level = LogLevel.Debug,
        Message = "Device Hub connection could not be stopped cleanly during shutdown.")]
    private static partial void LogStopFailure(ILogger logger, Exception exception);
}
