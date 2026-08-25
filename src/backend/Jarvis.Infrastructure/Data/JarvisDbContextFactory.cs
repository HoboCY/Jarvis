using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Design;

namespace Jarvis.Infrastructure.Data;

public sealed class JarvisDbContextFactory : IDesignTimeDbContextFactory<JarvisDbContext>
{
    public JarvisDbContext CreateDbContext(string[] args)
    {
        var options = new DbContextOptionsBuilder<JarvisDbContext>()
            .UseSqlite("Data Source=:memory:", sqlite => sqlite.MigrationsAssembly(typeof(JarvisDbContext).Assembly.FullName))
            .Options;

        return new JarvisDbContext(options);
    }
}
