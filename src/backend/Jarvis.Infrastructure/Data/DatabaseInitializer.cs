using Jarvis.Application.Identity;
using Jarvis.Domain.Identity;
using Jarvis.Domain.Devices;
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

        var desktopDevice = await db.Devices.AnyAsync(
            device => device.UserId == user.Id && device.DeviceType == DeviceType.Desktop,
            cancellationToken);
        if (!desktopDevice)
        {
            db.Devices.Add(Device.Create(
                Guid.CreateVersion7(),
                user.Id,
                "Local Desktop",
                DeviceType.Desktop,
                CurrentPlatform(),
                "{\"realtime\":true,\"microphone\":true,\"audioOutput\":true}",
                timeProvider.GetUtcNow().ToUnixTimeMilliseconds()));
            await db.SaveChangesAsync(cancellationToken);
        }

        localUser.UserId = user.Id;
    }

    private static string CurrentPlatform()
    {
        return OperatingSystem.IsMacOS()
            ? "macos"
            : OperatingSystem.IsWindows()
                ? "windows"
                : OperatingSystem.IsLinux()
                    ? "linux"
                    : "unknown";
    }
}
