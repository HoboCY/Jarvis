using Jarvis.Domain.Conversations;
using Jarvis.Domain.Devices;
using Jarvis.Domain.Idempotency;
using Jarvis.Domain.Identity;
using Jarvis.Domain.Outbox;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Metadata.Builders;

namespace Jarvis.Infrastructure.Data;

public sealed class JarvisDbContext(DbContextOptions<JarvisDbContext> options) : DbContext(options)
{
    public DbSet<User> Users => Set<User>();

    public DbSet<Device> Devices => Set<Device>();

    public DbSet<Conversation> Conversations => Set<Conversation>();

    public DbSet<Message> Messages => Set<Message>();

    public DbSet<IdempotencyRecord> IdempotencyRecords => Set<IdempotencyRecord>();

    public DbSet<OutboxMessage> OutboxMessages => Set<OutboxMessage>();

    protected override void OnModelCreating(ModelBuilder modelBuilder)
    {
        modelBuilder.Entity<User>(entity =>
        {
            entity.ToTable("Users");
            entity.HasKey(user => user.Id);
            entity.Property(user => user.DisplayName).HasMaxLength(200).IsRequired();
            entity.Property(user => user.Locale).HasMaxLength(32).IsRequired();
            entity.Property(user => user.TimeZone).HasMaxLength(128).IsRequired();
            ConfigureVersion(entity.Property(user => user.Version));
        });

        modelBuilder.Entity<Device>(entity =>
        {
            entity.ToTable("Devices");
            entity.HasKey(device => device.Id);
            entity.Property(device => device.Name).HasMaxLength(200).IsRequired();
            entity.Property(device => device.Platform).HasMaxLength(64).IsRequired();
            entity.Property(device => device.CapabilitiesJson).IsRequired();
            entity.HasIndex(device => new { device.UserId, device.Name }).IsUnique();
            entity.HasOne<User>()
                .WithMany()
                .HasForeignKey(device => device.UserId)
                .OnDelete(DeleteBehavior.Cascade);
            ConfigureVersion(entity.Property(device => device.Version));
        });

        modelBuilder.Entity<Conversation>(entity =>
        {
            entity.ToTable("Conversations");
            entity.HasKey(conversation => conversation.Id);
            entity.Property(conversation => conversation.Title).HasMaxLength(500).IsRequired();
            entity.HasIndex(conversation => new { conversation.UserId, conversation.LastActivityAtMs });
            entity.HasOne<User>()
                .WithMany()
                .HasForeignKey(conversation => conversation.UserId)
                .OnDelete(DeleteBehavior.Cascade);
            ConfigureVersion(entity.Property(conversation => conversation.Version));
        });

        modelBuilder.Entity<Message>(entity =>
        {
            entity.ToTable("Messages");
            entity.HasKey(message => message.Id);
            entity.Property(message => message.Text).HasMaxLength(100_000);
            entity.Property(message => message.ClientRequestId).HasMaxLength(200);
            entity.Property(message => message.MetadataJson).IsRequired();
            entity.HasIndex(message => new { message.ConversationId, message.Sequence }).IsUnique();
            entity.HasIndex(message => new { message.ConversationId, message.ExternalItemId }).IsUnique();
            entity.HasIndex(message => new { message.ConversationId, message.ClientRequestId }).IsUnique();
            entity.HasOne<Conversation>()
                .WithMany()
                .HasForeignKey(message => message.ConversationId)
                .OnDelete(DeleteBehavior.Cascade);
            ConfigureVersion(entity.Property(message => message.Version));
        });

        modelBuilder.Entity<IdempotencyRecord>(entity =>
        {
            entity.ToTable("IdempotencyRecords");
            entity.HasKey(record => new { record.UserId, record.Scope, record.IdempotencyKey });
            entity.Property(record => record.Scope).HasMaxLength(200);
            entity.Property(record => record.IdempotencyKey).HasMaxLength(200);
            entity.Property(record => record.RequestHash).HasMaxLength(128).IsRequired();
            entity.Property(record => record.ResponseJson).IsRequired();
            entity.HasOne<User>()
                .WithMany()
                .HasForeignKey(record => record.UserId)
                .OnDelete(DeleteBehavior.Cascade);
            ConfigureVersion(entity.Property(record => record.Version));
        });

        modelBuilder.Entity<OutboxMessage>(entity =>
        {
            entity.ToTable("OutboxMessages");
            entity.HasKey(message => message.Id);
            entity.Property(message => message.EventType).HasMaxLength(200).IsRequired();
            entity.Property(message => message.PayloadJson).IsRequired();
            entity.Property(message => message.LastError).HasMaxLength(2_000);
            entity.HasIndex(message => new
            {
                message.PublishedAtMs,
                message.NextAttemptAtMs,
                message.ClaimedUntilMs
            });
            ConfigureVersion(entity.Property(message => message.Version));
        });
    }

    public override int SaveChanges(bool acceptAllChangesOnSuccess)
    {
        BumpVersions();
        return base.SaveChanges(acceptAllChangesOnSuccess);
    }

    public override Task<int> SaveChangesAsync(
        bool acceptAllChangesOnSuccess,
        CancellationToken cancellationToken = default)
    {
        BumpVersions();
        return base.SaveChangesAsync(acceptAllChangesOnSuccess, cancellationToken);
    }

    private static void ConfigureVersion(PropertyBuilder<long> property)
    {
        property.IsConcurrencyToken();
        property.HasDefaultValue(0L);
    }

    private void BumpVersions()
    {
        foreach (var entry in ChangeTracker.Entries().Where(entry => entry.State == EntityState.Modified))
        {
            var version = entry.Metadata.FindProperty("Version");
            if (version is not null)
            {
                var original = (long)(entry.Property("Version").OriginalValue ?? 0L);
                entry.Property("Version").CurrentValue = original + 1L;
            }
        }
    }
}
