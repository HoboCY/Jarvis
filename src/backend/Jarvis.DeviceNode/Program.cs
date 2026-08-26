using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Options;
using Jarvis.DeviceNode;

var builder = Host.CreateApplicationBuilder(args);
builder.Services.AddSingleton(TimeProvider.System);
builder.Services
    .AddOptions<DeviceNodeOptions>()
    .Bind(builder.Configuration.GetSection(DeviceNodeOptions.SectionName))
    .Validate(options => Uri.TryCreate(options.ApiBaseUrl, UriKind.Absolute, out _), "DeviceNode:ApiBaseUrl must be an absolute URI.")
    .Validate(options => options.PollingIntervalMs >= 25, "DeviceNode:PollingIntervalMs must be at least 25ms.")
    .ValidateOnStart();
builder.Services.AddHttpClient<DeviceNodeHttpClient>((serviceProvider, client) =>
{
    var options = serviceProvider.GetRequiredService<IOptions<DeviceNodeOptions>>().Value;
    client.BaseAddress = new Uri(options.ApiBaseUrl, UriKind.Absolute);
    client.Timeout = TimeSpan.FromSeconds(30);
});
builder.Services.AddHttpClient<DeviceNodeRegistrationHttpClient>((serviceProvider, client) =>
{
    var options = serviceProvider.GetRequiredService<IOptions<DeviceNodeOptions>>().Value;
    client.BaseAddress = new Uri(options.ApiBaseUrl, UriKind.Absolute);
    client.Timeout = TimeSpan.FromSeconds(30);
});
builder.Services.AddSingleton<IDeviceNodeRegistrationClient>(serviceProvider =>
    serviceProvider.GetRequiredService<DeviceNodeRegistrationHttpClient>());
builder.Services.AddSingleton<IDeviceNodeIdentityStore, MacOsKeychainDeviceNodeIdentityStore>();
builder.Services.AddSingleton<DeviceNodeBootstrapper>();
builder.Services.AddSingleton<IDeviceNodeControlPlane>(serviceProvider =>
    serviceProvider.GetRequiredService<DeviceNodeHttpClient>());
builder.Services.AddSingleton<IDeviceApprovalDecisionWaiter, PollingApprovalDecisionWaiter>();
builder.Services.AddHostedService<DeviceNodeBootstrapHostedService>();
builder.Services.AddHostedService<DeviceNodeWorker>();
using var host = builder.Build();

await host.RunAsync();
