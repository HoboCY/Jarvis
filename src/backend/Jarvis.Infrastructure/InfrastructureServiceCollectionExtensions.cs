using Jarvis.Application.Conversations;
using Jarvis.Application.Approvals;
using Jarvis.Application.Devices;
using Jarvis.Application.Identity;
using Jarvis.Application.Memory;
using Jarvis.Application.Notifications;
using Jarvis.Application.Realtime;
using Jarvis.Application.Responses;
using Jarvis.Application.Tasks;
using Jarvis.Infrastructure.Conversations;
using Jarvis.Infrastructure.Data;
using Jarvis.Infrastructure.Idempotency;
using Jarvis.Infrastructure.Outbox;
using Jarvis.Infrastructure.Notifications;
using Jarvis.Infrastructure.Realtime;
using Jarvis.Infrastructure.Tasks;
using Jarvis.Infrastructure.Devices;
using Jarvis.Infrastructure.Memory;
using Jarvis.Infrastructure.Responses;
using Jarvis.Infrastructure.Summaries;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Diagnostics;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Http;

namespace Jarvis.Infrastructure;

public static class InfrastructureServiceCollectionExtensions
{
    public static IServiceCollection AddJarvisInfrastructure(
        this IServiceCollection services,
        IConfiguration configuration)
    {
        SQLitePCL.Batteries_V2.Init();

        services.AddSingleton(TimeProvider.System);
        services.AddDbContext<JarvisDbContext>((serviceProvider, options) =>
        {
            var connectionString = serviceProvider.GetRequiredService<IConfiguration>()
                .GetConnectionString("Jarvis")
                ?? "Data Source=jarvis.db";
            options.UseSqlite(
                connectionString,
                sqlite => sqlite.MigrationsAssembly(typeof(JarvisDbContext).Assembly.FullName));
            options.AddInterceptors(serviceProvider.GetServices<DbCommandInterceptor>());
        });
        services.AddSingleton<LocalUserIdentity>();
        services.AddScoped<DatabaseInitializer>();
        services.AddOptions<IdempotencyOptions>()
            .Bind(configuration.GetSection(IdempotencyOptions.SectionName))
            .Validate(options => options.RetentionMs > 0, "Idempotency:RetentionMs must be positive.")
            .ValidateOnStart();
        services.AddScoped<IConversationStore, EfConversationStore>();
        services.AddScoped<ConversationService>();
        services.AddScoped<EfDeviceStore>();
        services.AddScoped<IDeviceStore>(serviceProvider => serviceProvider.GetRequiredService<EfDeviceStore>());
        services.AddScoped<IApprovalStore>(serviceProvider => serviceProvider.GetRequiredService<EfDeviceStore>());
        services.AddScoped<DeviceCoordinationService>();
        services.AddScoped<DeviceLeaseRecoveryService>();
        services.AddHostedService<DeviceLeaseRecoveryHostedService>();
        services.AddScoped<ApprovalService>();
        services.AddScoped<EfTaskStore>();
        services.AddScoped<ITaskStore>(serviceProvider => serviceProvider.GetRequiredService<EfTaskStore>());
        services.AddScoped<TaskService>();
        services.AddScoped<INotificationStore, EfNotificationStore>();
        services.AddScoped<NotificationService>();
        services.AddScoped<FakeDelayWorker>();
        services.AddSingleton<IFakeDelayAdapter, FakeDelayAdapter>();
        services.AddOptions<FakeDelayOptions>()
            .Bind(configuration.GetSection(FakeDelayOptions.SectionName))
            .Validate(options => options.DelayMs is >= 0 and <= 60_000, "FakeWorker:DelayMs must be between 0 and 60000.")
            .Validate(options => options.PollingIntervalMs is >= 25 and <= 60_000, "FakeWorker:PollingIntervalMs must be between 25 and 60000.")
            .Validate(options => options.LeaseRenewalIntervalMs is >= 1 and <= 60_000, "FakeWorker:LeaseRenewalIntervalMs must be between 1 and 60000.")
            .Validate(options => FakeDelayOptions.IsValidWorkerDeviceId(options.WorkerDeviceId), "FakeWorker:WorkerDeviceId must be empty or a non-empty GUID.")
            .ValidateOnStart();
        services.AddOptions<ResponsesWorkerOptions>()
            .Bind(configuration.GetSection(ResponsesWorkerOptions.SectionName))
            .Validate(options => options.PollingIntervalMs is >= 25 and <= 60_000, "ResponsesWorker:PollingIntervalMs must be between 25 and 60000.")
            .Validate(options => options.LeaseDurationMs > 0, "ResponsesWorker:LeaseDurationMs must be positive.")
            .ValidateOnStart();
        services.AddSingleton<ResponsesWorkerIdentity>();
        services.AddScoped<ResponsesWorker>();
        services.AddHostedService<ResponsesWorkerHostedService>();
        services.AddHostedService<FakeDelayWorkerHostedService>();
        services.AddSingleton<ContextAssembler>();
        services.AddSingleton<EphemeralSecretReplayCache>();
        services.AddSingleton<RealtimeClientSecretSingleFlight>();
        services
            .AddOptions<OpenAiRealtimeOptions>()
            .Bind(configuration.GetSection(OpenAiRealtimeOptions.SectionName))
            .Validate(options => !string.IsNullOrWhiteSpace(options.ApiKey), "OpenAI:ApiKey is required.")
            .Validate(options => Uri.TryCreate(options.BaseUrl, UriKind.Absolute, out _), "OpenAI:BaseUrl must be an absolute URI.")
            .Validate(options => !string.IsNullOrWhiteSpace(options.RealtimeModel), "OpenAI:RealtimeModel is required.")
            .Validate(options => !string.IsNullOrWhiteSpace(options.RealtimeVoice), "OpenAI:RealtimeVoice is required.")
            .Validate(options => options.AllowedVoices.Length > 0, "OpenAI:AllowedVoices must contain at least one server-approved voice.")
            .Validate(options => options.AllowedVoices.Contains(options.RealtimeVoice, StringComparer.OrdinalIgnoreCase), "OpenAI:RealtimeVoice must be in OpenAI:AllowedVoices.")
            .Validate(options => !string.IsNullOrWhiteSpace(options.SafetyIdentifierSalt), "OpenAI:SafetyIdentifierSalt is required.")
            .Validate(options => !string.IsNullOrWhiteSpace(options.ResponsesModel), "OpenAI:ResponsesModel is required.")
            .Validate(options => !string.IsNullOrWhiteSpace(options.SummarizerModel), "OpenAI:SummarizerModel is required.")
            .Validate(options => options.ClientSecretLifetimeSeconds is >= 60 and <= 3600, "OpenAI:ClientSecretLifetimeSeconds must be between 60 and 3600.")
            .Validate(options => options.ResponsesTimeoutSeconds is >= 1 and <= 600, "OpenAI:ResponsesTimeoutSeconds must be between 1 and 600.")
            .Validate(options => options.ResponsesMaxTransientRetries is >= 0 and <= 3, "OpenAI:ResponsesMaxTransientRetries must be between 0 and 3.")
            .Validate(options => options.ResponsesPollingIntervalMs is >= 25 and <= 5_000, "OpenAI:ResponsesPollingIntervalMs must be between 25 and 5000.")
            .ValidateOnStart();
        services.AddHttpClient<IRealtimeClientSecretProvider, OpenAiRealtimeClientSecretProvider>((serviceProvider, client) =>
        {
            var options = serviceProvider.GetRequiredService<Microsoft.Extensions.Options.IOptions<OpenAiRealtimeOptions>>().Value;
            client.BaseAddress = new Uri(options.BaseUrl, UriKind.Absolute);
            client.Timeout = TimeSpan.FromSeconds(30);
        });
        services.AddSingleton<IRealtimeSafetyIdentifierProvider, ConfiguredRealtimeSafetyIdentifierProvider>();
        services.AddScoped<IRealtimeStore, EfRealtimeStore>();
        services.AddScoped<RealtimeService>();
        services.AddSingleton<IResponsesClientFactory, OpenAiResponsesClientFactory>();
        services.AddScoped<IResponsesRuntime, OpenAiResponsesRuntime>();
        services.AddScoped<ISummaryProvider, OpenAiSummaryProvider>();
        services.AddOptions<SummaryWorkerOptions>()
            .Bind(configuration.GetSection(SummaryWorkerOptions.SectionName))
            .Validate(options => options.PollingIntervalMs is >= 100 and <= 60_000, "SummaryWorker:PollingIntervalMs must be between 100 and 60000.")
            .Validate(options => options.MinimumMessageCount is >= 1 and <= 500, "SummaryWorker:MinimumMessageCount must be between 1 and 500.")
            .ValidateOnStart();
        services.AddScoped<SummaryWorker>();
        services.AddHostedService<SummaryWorkerHostedService>();
        services.AddOptions<MemoryOptions>()
            .Bind(configuration.GetSection(MemoryOptions.SectionName))
            .ValidateOnStart();
        services.AddScoped<MemoryService>();
        services.AddScoped<EfMemoryStore>();
        services.AddScoped<IMemoryStore>(serviceProvider => serviceProvider.GetRequiredService<EfMemoryStore>());
        services.AddOptions<OutboxOptions>()
            .Bind(configuration.GetSection(OutboxOptions.SectionName))
            .Validate(options => options.PollingIntervalMs >= 100, "Outbox:PollingIntervalMs must be at least 100ms.")
            .Validate(options => options.BatchSize is >= 1 and <= 100, "Outbox:BatchSize must be between 1 and 100.")
            .Validate(options => options.MaxBackoffMs > 0, "Outbox:MaxBackoffMs must be positive.")
            .Validate(options => options.LeaseDurationMs > 0, "Outbox:LeaseDurationMs must be positive.")
            .ValidateOnStart();
        services.AddSingleton<OutboxDispatcher>();
        services.AddHostedService(provider => provider.GetRequiredService<OutboxDispatcher>());

        return services;
    }
}
