namespace Jarvis.Domain.Conversations;

public enum RealtimeSessionStatus
{
    Created,
    Connected,
    Rotated,
    Disconnected,
    Failed
}

/// <summary>
/// The durable link between one short-lived realtime connection and a logical conversation.
/// Ephemeral client secrets are deliberately not part of this entity.
/// </summary>
public sealed class RealtimeSession
{
    private RealtimeSession()
    {
    }

    private RealtimeSession(
        Guid id,
        Guid conversationId,
        Guid deviceId,
        string model,
        string voice,
        long contextVersion,
        long nowMs)
    {
        Id = id;
        ConversationId = conversationId;
        DeviceId = deviceId;
        Model = model;
        Voice = voice;
        ContextVersion = contextVersion;
        Status = RealtimeSessionStatus.Created;
        StartedAtMs = nowMs;
    }

    public Guid Id { get; private set; }

    public Guid ConversationId { get; private set; }

    public Guid DeviceId { get; private set; }

    public string? ExternalSessionId { get; private set; }

    public string Model { get; private set; } = string.Empty;

    public string Voice { get; private set; } = string.Empty;

    public long ContextVersion { get; private set; }

    public RealtimeSessionStatus Status { get; private set; }

    public long StartedAtMs { get; private set; }

    public long? ConnectedAtMs { get; private set; }

    public long? RotatedAtMs { get; private set; }

    public long? DisconnectedAtMs { get; private set; }

    public long? FailedAtMs { get; private set; }

    public long? EndedAtMs { get; private set; }

    public string? EndReason { get; private set; }

    public long Version { get; private set; }

    public static RealtimeSession Create(
        Guid id,
        Guid conversationId,
        Guid deviceId,
        string model,
        string voice,
        long contextVersion,
        long nowMs)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(model);
        ArgumentException.ThrowIfNullOrWhiteSpace(voice);
        ArgumentOutOfRangeException.ThrowIfNegative(contextVersion);
        return new RealtimeSession(
            id,
            conversationId,
            deviceId,
            model.Trim(),
            voice.Trim(),
            contextVersion,
            nowMs);
    }

    public void MarkConnected(string externalSessionId, long nowMs)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(externalSessionId);
        if (Status is RealtimeSessionStatus.Disconnected or RealtimeSessionStatus.Failed or RealtimeSessionStatus.Rotated)
        {
            throw new InvalidOperationException("A terminal realtime session cannot be connected.");
        }

        ExternalSessionId ??= externalSessionId.Trim();
        if (!string.Equals(ExternalSessionId, externalSessionId.Trim(), StringComparison.Ordinal))
        {
            throw new InvalidOperationException("The external session identity cannot be changed.");
        }

        Status = RealtimeSessionStatus.Connected;
        ConnectedAtMs ??= nowMs;
    }

    public void MarkRotated(string reason, long nowMs)
    {
        MarkEnded(RealtimeSessionStatus.Rotated, reason, nowMs);
    }

    public void MarkDisconnected(string reason, long nowMs)
    {
        MarkEnded(RealtimeSessionStatus.Disconnected, reason, nowMs);
    }

    public void MarkFailed(string reason, long nowMs)
    {
        MarkEnded(RealtimeSessionStatus.Failed, reason, nowMs);
    }

    private void MarkEnded(RealtimeSessionStatus status, string reason, long nowMs)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(reason);
        if (Status is RealtimeSessionStatus.Rotated or RealtimeSessionStatus.Disconnected or RealtimeSessionStatus.Failed)
        {
            if (Status != status)
            {
                throw new InvalidOperationException("A terminal realtime session cannot change terminal status.");
            }

            return;
        }

        Status = status;
        EndReason = reason.Trim();
        EndedAtMs = nowMs;
        switch (status)
        {
            case RealtimeSessionStatus.Rotated:
                RotatedAtMs = nowMs;
                break;
            case RealtimeSessionStatus.Disconnected:
                DisconnectedAtMs = nowMs;
                break;
            case RealtimeSessionStatus.Failed:
                FailedAtMs = nowMs;
                break;
        }
    }
}
