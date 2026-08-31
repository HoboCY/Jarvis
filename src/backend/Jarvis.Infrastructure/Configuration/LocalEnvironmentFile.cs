using System.Text;
using Microsoft.Extensions.Configuration;

namespace Jarvis.Infrastructure;

/// <summary>
/// Parses the optional local <c>.env</c> file without changing the process
/// environment. Its provider remains lower priority than every existing or
/// subsequently added configuration provider.
/// </summary>
public static class LocalEnvironmentFile
{
    public const string DefaultFileName = ".env";

    public static string ResolvePath(string? workingDirectory = null)
    {
        var directory = workingDirectory ?? Directory.GetCurrentDirectory();
        ArgumentException.ThrowIfNullOrWhiteSpace(directory);
        return Path.Combine(directory, DefaultFileName);
    }

    public static IReadOnlyDictionary<string, string> Parse(string path)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(path);

        if (!File.Exists(path))
        {
            return new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        }

        var values = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        using var reader = new StreamReader(path);
        var lineNumber = 0;
        while (reader.ReadLine() is { } rawLine)
        {
            lineNumber++;
            var line = rawLine.Trim();
            if (line.Length == 0 || line.StartsWith('#'))
            {
                continue;
            }

            if (line.StartsWith("export", StringComparison.Ordinal)
                && line.Length > "export".Length
                && char.IsWhiteSpace(line["export".Length]))
            {
                line = line["export".Length..].TrimStart();
            }

            var separator = line.IndexOf('=');
            if (separator < 0)
            {
                throw InvalidEntry(path, lineNumber, "an entry must contain '='");
            }

            var key = line[..separator].Trim();
            if (!IsValidKey(key))
            {
                throw InvalidEntry(path, lineNumber, "the key is invalid");
            }

            var value = ParseValue(line[(separator + 1)..].Trim(), path, lineNumber);
            values[ToConfigurationKey(key)] = value;
        }

        return values;
    }

    public static void ApplyMissing(
        IConfigurationManager configuration,
        string? path = null)
    {
        ArgumentNullException.ThrowIfNull(configuration);

        var filePath = path ?? ResolvePath();
        configuration.Sources.Insert(0, new Source(filePath));
    }

    private static string ParseValue(string value, string path, int lineNumber)
    {
        if (value.Length == 0)
        {
            return string.Empty;
        }

        if (value[0] is '\'' or '"')
        {
            return ParseQuotedValue(value, value[0], path, lineNumber);
        }

        if (value.Contains('\'') || value.Contains('"'))
        {
            throw InvalidEntry(path, lineNumber, "a quoted value must start with its quote");
        }

        return value;
    }

    private static string ParseQuotedValue(
        string value,
        char quote,
        string path,
        int lineNumber)
    {
        var result = new StringBuilder();
        for (var index = 1; index < value.Length; index++)
        {
            var current = value[index];
            if (quote == '"' && current == '\\')
            {
                if (index + 1 >= value.Length)
                {
                    throw InvalidEntry(path, lineNumber, "the quoted value is not closed");
                }

                var escaped = value[++index];
                result.Append(escaped switch
                {
                    'n' => '\n',
                    'r' => '\r',
                    't' => '\t',
                    '"' => '"',
                    '\\' => '\\',
                    _ => throw InvalidEntry(path, lineNumber, "the quoted value contains an invalid escape")
                });
                continue;
            }

            if (current == quote)
            {
                if (value[(index + 1)..].Trim().Length != 0)
                {
                    throw InvalidEntry(path, lineNumber, "unexpected characters follow the quoted value");
                }

                return result.ToString();
            }

            result.Append(current);
        }

        throw InvalidEntry(path, lineNumber, "the quoted value is not closed");
    }

    private static bool IsValidKey(string key)
    {
        if (key.Length == 0)
        {
            return false;
        }

        var segments = key.Split("__", StringSplitOptions.None);
        for (var segmentIndex = 0; segmentIndex < segments.Length; segmentIndex++)
        {
            var segment = segments[segmentIndex];
            if (segment.Length == 0
                || !IsAsciiLetter(segment[0])
                    && segment[0] != '_'
                    && (segmentIndex == 0 || !char.IsAsciiDigit(segment[0])))
            {
                return false;
            }

            for (var index = 1; index < segment.Length; index++)
            {
                var character = segment[index];
                if (!IsAsciiLetter(character)
                    && !char.IsAsciiDigit(character)
                    && character != '_')
                {
                    return false;
                }
            }
        }

        return true;
    }

    private static string ToConfigurationKey(string key) =>
        key.Replace("__", ":", StringComparison.Ordinal);

    private static bool IsAsciiLetter(char character) =>
        character is >= 'A' and <= 'Z' or >= 'a' and <= 'z';

    private static LocalEnvironmentFileFormatException InvalidEntry(
        string path,
        int lineNumber,
        string reason) =>
        new(path, lineNumber, reason);

    private sealed class Source(string path) : IConfigurationSource
    {
        public IConfigurationProvider Build(IConfigurationBuilder builder) => new Provider(path);
    }

    private sealed class Provider(string path) : ConfigurationProvider
    {
        public override void Load()
        {
            var parsed = Parse(path);
            var data = new Dictionary<string, string?>(StringComparer.OrdinalIgnoreCase);
            foreach (var (key, value) in parsed)
            {
                data[key] = value;
            }

            Data = data;
        }
    }
}

public sealed class LocalEnvironmentFileFormatException : FormatException
{
    public LocalEnvironmentFileFormatException(string path, int lineNumber, string reason)
        : base($"Invalid local environment file '{Path.GetFileName(path)}' at line {lineNumber}: {reason}.")
    {
        FilePath = path;
        LineNumber = lineNumber;
    }

    public string FilePath { get; }

    public int LineNumber { get; }
}
