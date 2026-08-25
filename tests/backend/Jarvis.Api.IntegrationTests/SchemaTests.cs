using Jarvis.Domain.Conversations;
using Jarvis.Domain.Idempotency;
using Jarvis.Infrastructure.Data;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Xunit;

namespace Jarvis.Api.IntegrationTests;

public sealed class SchemaTests : IClassFixture<TestApplicationFactory>
{
    private readonly TestApplicationFactory _factory;

    public SchemaTests(TestApplicationFactory factory)
    {
        _factory = factory;
    }

    [Fact]
    public async Task MigrationCreatesPhase1TablesAndHasNoPendingModelChanges()
    {
        using var client = _factory.CreateClient();
        await using var scope = _factory.Services.CreateAsyncScope();
        var db = scope.ServiceProvider.GetRequiredService<JarvisDbContext>();

        Assert.Empty(await db.Database.GetPendingMigrationsAsync());
        await using var connection = db.Database.GetDbConnection();
        await connection.OpenAsync();
        await using var command = connection.CreateCommand();
        command.CommandText = "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name";
        await using var reader = await command.ExecuteReaderAsync();
        var tables = new List<string>();
        while (await reader.ReadAsync())
        {
            tables.Add(reader.GetString(0));
        }

        Assert.Contains("Users", tables);
        Assert.Contains("Devices", tables);
        Assert.Contains("Conversations", tables);
        Assert.Contains("Messages", tables);
        Assert.Contains("IdempotencyRecords", tables);
        Assert.Contains("OutboxMessages", tables);

        Assert.Equal(500, db.Model.FindEntityType(typeof(Conversation))!
            .FindProperty(nameof(Conversation.Title))!.GetMaxLength());
        Assert.Equal(200, db.Model.FindEntityType(typeof(Message))!
            .FindProperty(nameof(Message.ClientRequestId))!.GetMaxLength());
        Assert.Equal(200, db.Model.FindEntityType(typeof(IdempotencyRecord))!
            .FindProperty(nameof(IdempotencyRecord.IdempotencyKey))!.GetMaxLength());
        var expiresAt = db.Model.FindEntityType(typeof(IdempotencyRecord))!
            .FindProperty(nameof(IdempotencyRecord.ExpiresAtMs))!;
        Assert.Equal(typeof(long), expiresAt.ClrType);
        Assert.False(expiresAt.IsNullable);
    }
}
