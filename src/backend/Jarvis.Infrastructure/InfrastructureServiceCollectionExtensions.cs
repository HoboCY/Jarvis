using Jarvis.Application.Conversations;
using Jarvis.Application.Identity;
using Jarvis.Infrastructure.Conversations;
using Jarvis.Infrastructure.Data;
using Jarvis.Infrastructure.Idempotency;
using Jarvis.Infrastructure.Outbox;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Diagnostics;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;

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
