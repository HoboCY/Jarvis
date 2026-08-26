using Jarvis.Application.Outbox;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.DependencyInjection.Extensions;
using Microsoft.AspNetCore.TestHost;
using Microsoft.EntityFrameworkCore.Diagnostics;
using Jarvis.Application.Realtime;
using Jarvis.Application.Tasks;
using Jarvis.Application.Responses;

namespace Jarvis.Api.IntegrationTests;

public sealed class TestApplicationFactory : WebApplicationFactory<Program>
{
    private readonly bool _deleteDatabaseOnDispose;
    private readonly IOutboxPublisher? _outboxPublisher;
    private readonly TimeProvider? _timeProvider;
    private readonly IRealtimeClientSecretProvider? _realtimeProvider;
    private readonly IFakeDelayAdapter? _fakeDelayAdapter;
    private readonly string? _workerDeviceId;
    private readonly IResponsesRuntime? _responsesRuntime;
    private readonly ISummaryProvider? _summaryProvider;

    public TestApplicationFactory()
        : this(null, true, null)
    {
    }

    internal TestApplicationFactory(
        string? databasePath,
        bool deleteDatabaseOnDispose,
        IOutboxPublisher? outboxPublisher,
        TimeProvider? timeProvider = null,
        DbCommandInterceptor? dbCommandInterceptor = null,
        IRealtimeClientSecretProvider? realtimeProvider = null,
        IFakeDelayAdapter? fakeDelayAdapter = null,
        string? workerDeviceId = null,
        IResponsesRuntime? responsesRuntime = null,
        ISummaryProvider? summaryProvider = null)
    {
        DatabasePath = databasePath ?? Path.Combine(
            Path.GetTempPath(),
            $"jarvis-api-tests-{Guid.NewGuid():N}.db");
        _deleteDatabaseOnDispose = deleteDatabaseOnDispose;
        _outboxPublisher = outboxPublisher;
        _timeProvider = timeProvider;
        DbCommandInterceptor = dbCommandInterceptor;
        _realtimeProvider = realtimeProvider;
        _fakeDelayAdapter = fakeDelayAdapter;
        _workerDeviceId = workerDeviceId;
        _responsesRuntime = responsesRuntime;
        _summaryProvider = summaryProvider;
    }

    public string DatabasePath { get; }

    internal DbCommandInterceptor? DbCommandInterceptor { get; }

    public string Token { get; } = new('t', 64);

    protected override void ConfigureWebHost(IWebHostBuilder builder)
    {
        builder.UseEnvironment("Testing");
        var settings = new Dictionary<string, string?>
        {
            ["Authentication:BearerToken"] = Token,
            ["ConnectionStrings:Jarvis"] = $"Data Source={DatabasePath}",
            ["Outbox:Enabled"] = "false",
            ["FakeWorker:Enabled"] = "false",
            ["ResponsesWorker:Enabled"] = "false",
            ["SummaryWorker:Enabled"] = "false",
            ["SummaryWorker:MinimumMessageCount"] = "1",
            ["FakeWorker:DelayMs"] = "0",
            ["FakeWorker:LeaseRenewalIntervalMs"] = "10",
            ["OpenAI:ApiKey"] = "test-openai-key",
            ["OpenAI:BaseUrl"] = "https://api.openai.com/",
            ["OpenAI:RealtimeModel"] = "gpt-4o-realtime-preview",
            ["OpenAI:RealtimeVoice"] = "alloy",
            ["OpenAI:ResponsesModel"] = "gpt-4.1-mini",
            ["OpenAI:SummarizerModel"] = "gpt-4.1-mini",
            ["OpenAI:AllowedVoices:0"] = "alloy",
            ["OpenAI:SafetyIdentifierSalt"] = "test-safety-salt",
            ["OpenAI:ClientSecretLifetimeSeconds"] = "600",
            ["Diagnostics:AllowTestServerLoopback"] = "true"
        };
        if (_workerDeviceId is not null)
        {
            settings["FakeWorker:WorkerDeviceId"] = _workerDeviceId;
        }

        builder.ConfigureAppConfiguration((_, configuration) => configuration.AddInMemoryCollection(settings));
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
        if (_realtimeProvider is not null)
        {
            builder.ConfigureTestServices(services =>
            {
                services.RemoveAll<IRealtimeClientSecretProvider>();
                services.AddSingleton(_realtimeProvider);
            });
        }
        if (_fakeDelayAdapter is not null)
        {
            builder.ConfigureTestServices(services =>
            {
                services.RemoveAll<IFakeDelayAdapter>();
                services.AddSingleton(_fakeDelayAdapter);
            });
        }
        if (_responsesRuntime is not null)
        {
            builder.ConfigureTestServices(services =>
            {
                services.RemoveAll<IResponsesRuntime>();
                services.AddSingleton(_responsesRuntime);
            });
        }
        if (_summaryProvider is not null)
        {
            builder.ConfigureTestServices(services =>
            {
                services.RemoveAll<ISummaryProvider>();
                services.AddSingleton(_summaryProvider);
            });
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
