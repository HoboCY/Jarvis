using Jarvis.Application.Conversations;
using Jarvis.Application.Identity;
using Jarvis.Application.Realtime;
using Jarvis.Infrastructure.Conversations;
using Jarvis.Infrastructure.Data;
using Jarvis.Infrastructure.Idempotency;
using Jarvis.Infrastructure.Outbox;
using Jarvis.Infrastructure.Realtime;
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
            .Validate(options => options.ClientSecretLifetimeSeconds is >= 60 and <= 3600, "OpenAI:ClientSecretLifetimeSeconds must be between 60 and 3600.")
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
