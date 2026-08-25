using Jarvis.Application.Identity;
using Jarvis.Domain.Identity;
using Microsoft.EntityFrameworkCore;

namespace Jarvis.Infrastructure.Data;

public sealed class DatabaseInitializer(
    JarvisDbContext db,
    LocalUserIdentity localUser,
    TimeProvider timeProvider)
{
    public async Task InitializeAsync(CancellationToken cancellationToken = default)
    {
        await db.Database.MigrateAsync(cancellationToken);

        var user = await db.Users.OrderBy(item => item.CreatedAtMs).FirstOrDefaultAsync(cancellationToken);
        if (user is null)
        {
            user = User.Create(
                Guid.CreateVersion7(),
                "Local User",
                "zh-CN",
                "Asia/Shanghai",
                timeProvider.GetUtcNow().ToUnixTimeMilliseconds());
            db.Users.Add(user);
            await db.SaveChangesAsync(cancellationToken);
        }

        localUser.UserId = user.Id;
    }
}
