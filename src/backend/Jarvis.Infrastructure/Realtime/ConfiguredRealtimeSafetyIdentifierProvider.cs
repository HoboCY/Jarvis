using Jarvis.Application.Realtime;
using Microsoft.Extensions.Options;

namespace Jarvis.Infrastructure.Realtime;

public sealed class ConfiguredRealtimeSafetyIdentifierProvider(
    IOptions<OpenAiRealtimeOptions> options) : IRealtimeSafetyIdentifierProvider
{
    public string Create(Guid userId)
    {
        return SafetyIdentifier.Create(userId, options.Value.SafetyIdentifierSalt);
    }
}
