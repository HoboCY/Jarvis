using Jarvis.Contracts;

namespace Jarvis.Application.Tasks;

/// <summary>
/// Shared bounded validation for the pinned Codex user-input wire shape and the
/// public answer projection. Provider JSON is parsed by Device Node and converted
/// to these contracts before entering the application boundary.
/// </summary>
public static class TaskUserInputValidation
{
    public const int MaxQuestions = 3;
    public const int MaxQuestionIdLength = 200;
    public const int MaxHeaderLength = 200;
    public const int MaxQuestionLength = 4_000;
    public const int MaxOptions = 20;
    public const int MaxOptionLabelLength = 200;
    public const int MaxOptionDescriptionLength = 2_000;
    public const int MaxRequestIdLength = 200;
    public const int MaxProviderIdLength = 500;
    public const int MaxAnswersPerQuestion = 20;
    public const int MaxAnswerLength = 4_000;
    public const int MaxTotalAnswerLength = 20_000;
    public const long MaxLifetimeMs = 24L * 60 * 60 * 1_000;

    public static bool TryValidateRequest(
        DeviceTaskUserInputRequest request,
        long nowMs,
        out string error)
    {
        error = string.Empty;
        if (request.ExecutionId == Guid.Empty
            || !IsBoundedNonEmpty(request.RequestId, MaxRequestIdLength)
            || !IsBoundedNonEmpty(request.ItemId, MaxProviderIdLength)
            || !IsBoundedNonEmpty(request.ThreadId, MaxProviderIdLength)
            || !IsBoundedNonEmpty(request.TurnId, MaxProviderIdLength))
        {
            error = "The user-input request identity is invalid.";
            return false;
        }

        if (request.Questions is null || request.Questions.Count is < 1 or > MaxQuestions)
        {
            error = "Codex user-input requests must contain between one and three questions.";
            return false;
        }

        var ids = new HashSet<string>(StringComparer.Ordinal);
        foreach (var question in request.Questions)
        {
            if (question is null
                || !IsBoundedNonEmpty(question.Id, MaxQuestionIdLength)
                || !ids.Add(question.Id.Trim())
                || !IsBoundedNonEmpty(question.Header, MaxHeaderLength)
                || !IsBoundedNonEmpty(question.Question, MaxQuestionLength))
            {
                error = "Codex user-input question metadata is invalid.";
                return false;
            }

            if (question.IsSecret)
            {
                error = "Secret user-input questions are not supported.";
                return false;
            }

            if (question.Options is { Count: > MaxOptions })
            {
                error = "A user-input question contains too many options.";
                return false;
            }

            if (question.Options is not null)
            {
                var labels = new HashSet<string>(StringComparer.Ordinal);
                foreach (var option in question.Options)
                {
                    if (option is null
                        || !IsBoundedNonEmpty(option.Label, MaxOptionLabelLength)
                        || !IsBoundedNonEmpty(option.Description, MaxOptionDescriptionLength)
                        || !labels.Add(option.Label.Trim()))
                    {
                        error = "A user-input option is invalid.";
                        return false;
                    }
                }
            }
        }

        if (request.AutoResolutionMs is < 0 or > MaxLifetimeMs)
        {
            error = "autoResolutionMs is outside the supported range.";
            return false;
        }

        if (nowMs < 0)
        {
            error = "The request timestamp is invalid.";
            return false;
        }

        return true;
    }

    public static bool TryValidateSubmission(
        TaskUserInputSubmissionRequest request,
        IReadOnlyList<TaskUserInputQuestion> questions,
        out string error)
    {
        error = string.Empty;
        if (!IsBoundedNonEmpty(request.RequestId, MaxRequestIdLength))
        {
            error = "requestId is required and is too long.";
            return false;
        }

        if (request.Answers is null || request.Answers.Count != questions.Count)
        {
            error = "An answer is required for every user-input question.";
            return false;
        }

        if (questions is null || questions.Any(question => question is null))
        {
            error = "The durable user-input question set is invalid.";
            return false;
        }

        var questionById = questions.ToDictionary(question => question.Id, StringComparer.Ordinal);
        var totalLength = 0;
        foreach (var pair in request.Answers)
        {
            if (!questionById.TryGetValue(pair.Key, out var question)
                || pair.Value is null
                || pair.Value.Answers is null
                || pair.Value.Answers.Count is < 1 or > MaxAnswersPerQuestion)
            {
                error = "The user-input answer keys or values are invalid.";
                return false;
            }

            var allowedLabels = question.Options?.Select(option => option.Label).ToHashSet(StringComparer.Ordinal);
            foreach (var answer in pair.Value.Answers)
            {
                if (!IsBoundedNonEmpty(answer, MaxAnswerLength))
                {
                    error = "A user-input answer is invalid or too long.";
                    return false;
                }

                var normalized = answer.Trim();
                if (allowedLabels is { Count: > 0 }
                    && !question.IsOther
                    && !allowedLabels.Contains(normalized))
                {
                    error = "A user-input answer must be one of the provided options.";
                    return false;
                }

                totalLength = checked(totalLength + normalized.Length);
                if (totalLength > MaxTotalAnswerLength)
                {
                    error = "The total user-input answer is too long.";
                    return false;
                }
            }
        }

        if (request.Answers.Keys.Any(key => !questionById.ContainsKey(key)))
        {
            error = "The user-input answer contains an unknown question id.";
            return false;
        }

        return true;
    }

    public static long? GetExpiry(long nowMs, long? autoResolutionMs)
    {
        if (autoResolutionMs is null)
        {
            return null;
        }

        return checked(nowMs + autoResolutionMs.Value);
    }

    private static bool IsBoundedNonEmpty(string? value, int maxLength) =>
        !string.IsNullOrWhiteSpace(value) && value.Trim().Length <= maxLength;
}
