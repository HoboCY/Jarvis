using System.Globalization;
using System.Text;
using Jarvis.Application.Devices;

namespace Jarvis.DeviceNode.Codex;

/// <summary>
/// The task-scoped native Codex permissions profile passed to one app-server process.
/// </summary>
public sealed class CodexTaskPermissionProfile
{
    private static readonly string[] SensitiveGlobs =
    [
        ".env",
        "**/.env",
        ".env.*",
        "**/.env.*",
        "*.env",
        "**/*.env",
        ".ssh",
        ".ssh/**",
        "**/.ssh",
        "**/.ssh/**",
        ".aws",
        ".aws/**",
        "**/.aws",
        "**/.aws/**",
        ".azure",
        ".azure/**",
        "**/.azure",
        "**/.azure/**",
        ".config/gcloud",
        ".config/gcloud/**",
        "**/.config/gcloud",
        "**/.config/gcloud/**",
        "id_rsa",
        "**/id_rsa",
        "id_ed25519",
        "**/id_ed25519",
        "credentials",
        "credentials/**",
        "**/credentials",
        "**/credentials/**",
        "secrets.json",
        "**/secrets.json"
    ];

    private CodexTaskPermissionProfile(string id, IReadOnlyList<string> cliConfigOverrides)
    {
        Id = id;
        CliConfigOverrides = cliConfigOverrides;
    }

    public string Id { get; }

    /// <summary>
    /// Values for repeated <c>codex app-server -c key=value</c> arguments.
    /// </summary>
    public IReadOnlyList<string> CliConfigOverrides { get; }

    public static CodexTaskPermissionProfile Create(Guid taskId, CapabilityPolicy policy)
    {
        if (taskId == Guid.Empty)
        {
            throw new ArgumentException("A task id is required.", nameof(taskId));
        }

        ArgumentNullException.ThrowIfNull(policy);

        var id = $"jarvis-task-{taskId:N}";
        var filesystemEntries = new List<string>
        {
            $"{TomlKey(":minimal")}={TomlString("read")}"
        };

        var access = policy.WriteFiles
            ? "write"
            : policy.ReadFiles ? "read" : null;
        if (access is not null)
        {
            foreach (var root in policy.AllowedRoots)
            {
                filesystemEntries.Add($"{TomlKey(root)}={TomlString(access)}");
                foreach (var sensitivePath in SensitivePaths(root))
                {
                    filesystemEntries.Add($"{TomlKey(sensitivePath)}={TomlString("deny")}");
                }
            }
        }

        var overrides = new List<string>
        {
            $"default_permissions={TomlString(id)}",
            $"permissions.{id}.filesystem={{{string.Join(",", filesystemEntries)}}}",
        };
        overrides.Add($"permissions.{id}.network.enabled={(policy.Network ? "true" : "false")}");
        return new CodexTaskPermissionProfile(id, overrides);
    }

    private static IEnumerable<string> SensitivePaths(string root)
    {
        foreach (var glob in SensitiveGlobs)
        {
            yield return $"{root.TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar)}{Path.DirectorySeparatorChar}{glob.Replace('/', Path.DirectorySeparatorChar)}";
        }
    }

    private static string TomlKey(string value) => TomlString(value);

    private static string TomlString(string value)
    {
        var builder = new StringBuilder(value.Length + 2);
        builder.Append('"');
        foreach (var character in value)
        {
            switch (character)
            {
                case '\\':
                    builder.Append("\\\\");
                    break;
                case '"':
                    builder.Append("\\\"");
                    break;
                case '\b':
                    builder.Append("\\b");
                    break;
                case '\t':
                    builder.Append("\\t");
                    break;
                case '\n':
                    builder.Append("\\n");
                    break;
                case '\f':
                    builder.Append("\\f");
                    break;
                case '\r':
                    builder.Append("\\r");
                    break;
                default:
                    if (character < ' ' || character == '\u007f')
                    {
                        builder.Append("\\u");
                        builder.Append(((int)character).ToString("x4", CultureInfo.InvariantCulture));
                    }
                    else
                    {
                        builder.Append(character);
                    }

                    break;
            }
        }

        builder.Append('"');
        return builder.ToString();
    }
}
