using Jarvis.Application.Outbox;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.DependencyInjection.Extensions;
using Microsoft.AspNetCore.TestHost;
using Microsoft.EntityFrameworkCore.Diagnostics;

namespace Jarvis.Api.IntegrationTests;

public sealed class TestApplicationFactory : WebApplicationFactory<Program>
{
    private readonly bool _deleteDatabaseOnDispose;
    private readonly IOutboxPublisher? _outboxPublisher;
    private readonly TimeProvider? _timeProvider;

    public TestApplicationFactory()
        : this(null, true, null)
    {
    }

    internal TestApplicationFactory(
        string? databasePath,
        bool deleteDatabaseOnDispose,
        IOutboxPublisher? outboxPublisher,
        TimeProvider? timeProvider = null,
        DbCommandInterceptor? dbCommandInterceptor = null)
    {
        DatabasePath = databasePath ?? Path.Combine(
            Path.GetTempPath(),
            $"jarvis-api-tests-{Guid.NewGuid():N}.db");
        _deleteDatabaseOnDispose = deleteDatabaseOnDispose;
        _outboxPublisher = outboxPublisher;
        _timeProvider = timeProvider;
        DbCommandInterceptor = dbCommandInterceptor;
    }

    public string DatabasePath { get; }

    internal DbCommandInterceptor? DbCommandInterceptor { get; }

    public string Token { get; } = new('t', 64);

    protected override void ConfigureWebHost(IWebHostBuilder builder)
    {
        builder.UseEnvironment("Testing");
        builder.ConfigureAppConfiguration((_, configuration) => configuration.AddInMemoryCollection(
            new Dictionary<string, string?>
            {
                ["Authentication:BearerToken"] = Token,
                ["ConnectionStrings:Jarvis"] = $"Data Source={DatabasePath}",
                ["Outbox:Enabled"] = "false"
            }));
        if (_outboxPublisher is not null)
        {
            builder.ConfigureTestServices(services =>
            {
                services.RemoveAll<IOutboxPublisher>();
                services.AddSingleton(_outboxPublisher);
            });
        }
        if (_timeProvider is not null)
        {
            builder.ConfigureTestServices(services =>
            {
                services.RemoveAll<TimeProvider>();
                services.AddSingleton(_timeProvider);
            });
        }
        if (DbCommandInterceptor is not null)
        {
            builder.ConfigureTestServices(services => services.AddSingleton(DbCommandInterceptor));
        }
    }

    protected override void Dispose(bool disposing)
    {
        base.Dispose(disposing);
        if (disposing && _deleteDatabaseOnDispose)
        {
            DeleteDatabaseFiles();
        }
    }

    private void DeleteDatabaseFiles()
    {
        foreach (var path in new[] { DatabasePath, $"{DatabasePath}-wal", $"{DatabasePath}-shm" })
        {
            if (File.Exists(path))
            {
                File.Delete(path);
            }
        }
    }
}
