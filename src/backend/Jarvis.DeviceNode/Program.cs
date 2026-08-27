using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Options;
using Jarvis.DeviceNode;
using Jarvis.Infrastructure.Resilience;
using Jarvis.Infrastructure.Observability;

var builder = Host.CreateApplicationBuilder(args);
builder.Logging.ClearProviders();
builder.Logging.AddJarvisJsonConsole();
builder.Services.AddJarvisTelemetry(builder.Configuration, "jarvis.device-node");
builder.Services.AddSingleton(TimeProvider.System);
builder.Services.AddOptions<ResilienceOptions>()
    .Bind(builder.Configuration.GetSection(ResilienceOptions.SectionName))
    .Validate(options => options.MaxRetryAttempts is >= 0 and <= 5, "Resilience:MaxRetryAttempts must be between 0 and 5.")
    .Validate(options => options.RetryBaseDelayMs > 0, "Resilience:RetryBaseDelayMs must be positive.")
    .Validate(options => options.RetryMaxDelayMs >= options.RetryBaseDelayMs, "Resilience:RetryMaxDelayMs must not be less than RetryBaseDelayMs.")
    .Validate(options => options.AttemptTimeoutMs > 0, "Resilience:AttemptTimeoutMs must be positive.")
    .Validate(options => options.TotalTimeoutMs >= options.AttemptTimeoutMs, "Resilience:TotalTimeoutMs must not be less than AttemptTimeoutMs.")
    .Validate(options => options.CircuitFailureRatio is > 0 and <= 1, "Resilience:CircuitFailureRatio must be greater than 0 and at most 1.")
    .Validate(options => options.CircuitMinimumThroughput >= 2, "Resilience:CircuitMinimumThroughput must be at least 2.")
    .Validate(options => options.CircuitSamplingDurationMs >= 501, "Resilience:CircuitSamplingDurationMs must be at least 501ms.")
    .Validate(options => options.CircuitBreakDurationMs >= 501, "Resilience:CircuitBreakDurationMs must be at least 501ms.")
    .ValidateOnStart();
builder.Services
    .AddOptions<DeviceNodeOptions>()
    .Bind(builder.Configuration.GetSection(DeviceNodeOptions.SectionName))
    .Validate(options => Uri.TryCreate(options.ApiBaseUrl, UriKind.Absolute, out _), "DeviceNode:ApiBaseUrl must be an absolute URI.")
    .Validate(options => CodexHomeValidator.IsValid(options.CodexHome), "DeviceNode:CodexHome must be an existing owner-only absolute directory other than the filesystem root.")
    .Validate(options => options.PollingIntervalMs >= 25, "DeviceNode:PollingIntervalMs must be at least 25ms.")
    .ValidateOnStart();
builder.Services.AddHttpClient<DeviceNodeHttpClient>((serviceProvider, client) =>
{
    var options = serviceProvider.GetRequiredService<IOptions<DeviceNodeOptions>>().Value;
    client.BaseAddress = new Uri(options.ApiBaseUrl, UriKind.Absolute);
    client.Timeout = TimeSpan.FromSeconds(30);
})
    .AddHttpMessageHandler<CorrelationIdHttpMessageHandler>()
    .AddJarvisHttpResilience(serviceProvider =>
        serviceProvider.GetRequiredService<IOptions<ResilienceOptions>>().Value);
builder.Services.AddHttpClient<DeviceNodeRegistrationHttpClient>((serviceProvider, client) =>
{
    var options = serviceProvider.GetRequiredService<IOptions<DeviceNodeOptions>>().Value;
    client.BaseAddress = new Uri(options.ApiBaseUrl, UriKind.Absolute);
    client.Timeout = TimeSpan.FromSeconds(30);
})
    .AddHttpMessageHandler<CorrelationIdHttpMessageHandler>()
    .AddJarvisHttpResilience(serviceProvider =>
        serviceProvider.GetRequiredService<IOptions<ResilienceOptions>>().Value);
builder.Services.AddTransient<CorrelationIdHttpMessageHandler>();
builder.Services.AddSingleton<IDeviceNodeRegistrationClient>(serviceProvider =>
    serviceProvider.GetRequiredService<DeviceNodeRegistrationHttpClient>());
builder.Services.AddSingleton<IDeviceNodeIdentityStore>(serviceProvider =>
{
    var options = serviceProvider.GetRequiredService<IOptions<DeviceNodeOptions>>().Value;
    return string.IsNullOrWhiteSpace(options.CredentialFilePath)
        ? new MacOsKeychainDeviceNodeIdentityStore(Options.Create(options))
        : new OwnerOnlyFileDeviceNodeIdentityStore(Options.Create(options));
});
builder.Services.AddSingleton<DeviceNodeBootstrapper>();
builder.Services.AddSingleton<IDeviceNodeControlPlane>(serviceProvider =>
    serviceProvider.GetRequiredService<DeviceNodeHttpClient>());
builder.Services.AddSingleton<IDeviceNodeWakeSignal>(serviceProvider =>
    new DeviceNodeWakeSignal(serviceProvider.GetRequiredService<TimeProvider>()));
builder.Services.AddSingleton<IDeviceNodeHubConnectionFactory, SignalRDeviceNodeHubConnectionFactory>();
builder.Services.AddSingleton<IDeviceApprovalDecisionWaiter, PollingApprovalDecisionWaiter>();
builder.Services.AddSingleton<IDeviceUserInputWaiter, PollingUserInputWaiter>();
builder.Services.AddHostedService<DeviceNodeBootstrapHostedService>();
builder.Services.AddHostedService<DeviceNodeSignalRHostedService>();
builder.Services.AddHostedService<DeviceNodeWorker>();
using var host = builder.Build();

await host.RunAsync();
