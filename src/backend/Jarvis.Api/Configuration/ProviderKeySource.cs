using System.Text.Json;

namespace Jarvis.Api.Configuration;

public static class ProviderKeySource
{
    private const int MaximumSourceBytes = 256 * 1024;

    public static void AddProviderKeySource(this ConfigurationManager configuration)
    {
        var sourcePath = configuration["ProviderKeySource:Path"];
        if (sourcePath is null)
        {
            return;
        }

        try
        {
            if (!Path.IsPathFullyQualified(sourcePath))
            {
                throw InvalidSource();
            }

            using var stream = File.OpenRead(sourcePath);
            if (stream.Length > MaximumSourceBytes)
            {
                throw InvalidSource();
            }

            // Bound the read even if the source grows after its length is checked.
            var bytes = new byte[MaximumSourceBytes + 1];
            var length = stream.ReadAtLeast(bytes, bytes.Length, throwOnEndOfStream: false);
            if (length > MaximumSourceBytes)
            {
                throw InvalidSource();
            }

            var offset = length >= 3 && bytes[0] == 0xef && bytes[1] == 0xbb && bytes[2] == 0xbf ? 3 : 0;
            using var document = JsonDocument.Parse(bytes.AsMemory(offset, length - offset));
            var openAiKey = ReadKey(document.RootElement, "OpenAI");
            var deepSeekKey = ReadKey(document.RootElement, "DeepSeek");
            configuration.AddInMemoryCollection(new Dictionary<string, string?>
            {
                ["OpenAI:ApiKey"] = openAiKey,
                ["DeepSeek:ApiKey"] = deepSeekKey
            });
        }
        catch (Exception exception) when (exception is IOException or UnauthorizedAccessException
            or JsonException or ArgumentException or NotSupportedException)
        {
            // Never propagate source paths, JSON fragments, or credentials to startup logs.
            throw InvalidSource();
        }
    }

    private static string ReadKey(JsonElement root, string section)
    {
        if (root.ValueKind != JsonValueKind.Object)
        {
            throw InvalidSource();
        }

        JsonElement value = default;
        var flatName = $"{section}:ApiKey";
        foreach (var property in root.EnumerateObject())
        {
            if (property.Name.Equals(flatName, StringComparison.OrdinalIgnoreCase))
            {
                value = property.Value;
                break;
            }
        }

        if (value.ValueKind == JsonValueKind.Undefined)
        {
            foreach (var property in root.EnumerateObject())
            {
                if (!property.Name.Equals(section, StringComparison.OrdinalIgnoreCase)
                    || property.Value.ValueKind != JsonValueKind.Object)
                {
                    continue;
                }

                foreach (var field in property.Value.EnumerateObject())
                {
                    if (field.Name.Equals("ApiKey", StringComparison.OrdinalIgnoreCase))
                    {
                        value = field.Value;
                        break;
                    }
                }
                break;
            }
        }

        var key = value.ValueKind == JsonValueKind.String ? value.GetString()?.Trim() : null;
        return !string.IsNullOrEmpty(key) && key.Length <= 4096 && !key.Any(character => character < 0x20 || character == 0x7f)
            ? key
            : throw InvalidSource();
    }

    private static InvalidOperationException InvalidSource() => new("PROVIDER_KEY_SOURCE_INVALID");
}
