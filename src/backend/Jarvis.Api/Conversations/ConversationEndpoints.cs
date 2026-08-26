using System.Security.Claims;
using Jarvis.Application.Conversations;
using Jarvis.Contracts;
using Jarvis.Infrastructure.Observability;
using System.Diagnostics;

namespace Jarvis.Api.Conversations;

public static class ConversationEndpoints
{
    public static IEndpointRouteBuilder MapConversationEndpoints(this IEndpointRouteBuilder endpoints)
    {
        var group = endpoints.MapGroup("/api/v1/conversations").RequireAuthorization();

        group.MapPost("", CreateAsync)
            .WithName("CreateConversation")
            .WithSummary("Creates a conversation for the authenticated local user.")
            .Produces<ConversationResponse>(StatusCodes.Status201Created)
            .ProducesProblem(StatusCodes.Status401Unauthorized)
            .ProducesProblem(StatusCodes.Status400BadRequest)
            .ProducesProblem(StatusCodes.Status409Conflict);

        group.MapGet("/{conversationId:guid}", GetAsync)
            .WithName("GetConversation")
            .WithSummary("Returns an owned conversation and its recent messages.")
            .Produces<ConversationResponse>()
            .ProducesProblem(StatusCodes.Status401Unauthorized)
            .ProducesProblem(StatusCodes.Status404NotFound);

        group.MapGet("/{conversationId:guid}/messages", GetMessagesAsync)
            .WithName("GetConversationMessages")
            .WithSummary("Returns owned conversation messages using a descending cursor.")
            .Produces<MessagePageResponse>()
            .ProducesProblem(StatusCodes.Status401Unauthorized)
            .ProducesProblem(StatusCodes.Status400BadRequest)
            .ProducesProblem(StatusCodes.Status404NotFound);

        group.MapPost("/{conversationId:guid}/messages/typed", AddTypedMessageAsync)
            .WithName("AddTypedConversationMessage")
            .WithSummary("Persists a typed message exactly once for an idempotency key.")
            .Produces<TypedMessageResponse>()
            .ProducesProblem(StatusCodes.Status401Unauthorized)
            .ProducesProblem(StatusCodes.Status400BadRequest)
            .ProducesProblem(StatusCodes.Status404NotFound)
            .ProducesProblem(StatusCodes.Status409Conflict);

        return endpoints;
    }

    private static async Task<IResult> CreateAsync(
        HttpContext httpContext,
        ConversationService service,
        CreateConversationRequest request,
        CancellationToken cancellationToken)
    {
        if (!TryGetUserId(httpContext, out var userId))
        {
            return Problem(StatusCodes.Status401Unauthorized, "Unauthorized", "Authentication is required.");
        }

        var result = await service.CreateAsync(
            userId,
            httpContext.Request.Headers["Idempotency-Key"].FirstOrDefault(),
            request,
            cancellationToken);
        return result.Status switch
        {
            ConversationOperationStatus.Succeeded or ConversationOperationStatus.Replayed
                when result.ResponseStatus == StatusCodes.Status201Created => TypedResults.Created(
                    $"/api/v1/conversations/{result.Value!.Id}",
                    result.Value),
            ConversationOperationStatus.Succeeded or ConversationOperationStatus.Replayed => TypedResults.Ok(result.Value),
            ConversationOperationStatus.Invalid => Problem(StatusCodes.Status400BadRequest, "Invalid request", result.Detail),
            ConversationOperationStatus.Conflict => Problem(StatusCodes.Status409Conflict, "Idempotency conflict", result.Detail),
            _ => Problem(StatusCodes.Status500InternalServerError, "Unexpected result", "The conversation could not be created.")
        };
    }

    private static async Task<IResult> GetAsync(
        Guid conversationId,
        HttpContext httpContext,
        ConversationService service,
        CancellationToken cancellationToken)
    {
        if (!TryGetUserId(httpContext, out var userId))
        {
            return Problem(StatusCodes.Status401Unauthorized, "Unauthorized", "Authentication is required.");
        }

        var result = await service.GetAsync(userId, conversationId, cancellationToken);
        return result.Status == ConversationOperationStatus.Succeeded
            ? TypedResults.Ok(result.Value)
            : Problem(StatusCodes.Status404NotFound, "Conversation not found", "The conversation does not exist or is not owned by this user.");
    }

    private static async Task<IResult> GetMessagesAsync(
        Guid conversationId,
        long? cursor,
        int? limit,
        HttpContext httpContext,
        ConversationService service,
        CancellationToken cancellationToken)
    {
        if (!TryGetUserId(httpContext, out var userId))
        {
            return Problem(StatusCodes.Status401Unauthorized, "Unauthorized", "Authentication is required.");
        }

        var result = await service.GetMessagesAsync(
            userId,
            conversationId,
            cursor,
            limit ?? 20,
            cancellationToken);
        return result.Status switch
        {
            ConversationOperationStatus.Succeeded => TypedResults.Ok(result.Value),
            ConversationOperationStatus.Invalid => Problem(StatusCodes.Status400BadRequest, "Invalid pagination", result.Detail),
            _ => Problem(StatusCodes.Status404NotFound, "Conversation not found", "The conversation does not exist or is not owned by this user.")
        };
    }

    private static async Task<IResult> AddTypedMessageAsync(
        Guid conversationId,
        HttpContext httpContext,
        ConversationService service,
        TypedMessageRequest request,
        CancellationToken cancellationToken)
    {
        if (!TryGetUserId(httpContext, out var userId))
        {
            return Problem(StatusCodes.Status401Unauthorized, "Unauthorized", "Authentication is required.");
        }

        var startedAt = Stopwatch.GetTimestamp();
        var result = await service.AddTypedMessageAsync(
            userId,
            conversationId,
            httpContext.Request.Headers["Idempotency-Key"].FirstOrDefault(),
            request,
            cancellationToken);
        if (result.Status is ConversationOperationStatus.Succeeded or ConversationOperationStatus.Replayed)
        {
            JarvisTelemetry.RealtimeTypedMessageDuration.Record(
                Stopwatch.GetElapsedTime(startedAt).TotalMilliseconds,
                JarvisTelemetry.BoundedTags(("operation", "typed_message")).ToArray());
        }
        return result.Status switch
        {
            ConversationOperationStatus.Succeeded => TypedResults.Ok(result.Value),
            ConversationOperationStatus.Replayed => TypedResults.Ok(result.Value),
            ConversationOperationStatus.Invalid => Problem(StatusCodes.Status400BadRequest, "Invalid request", result.Detail),
            ConversationOperationStatus.NotFound => Problem(StatusCodes.Status404NotFound, "Conversation not found", "The conversation does not exist or is not owned by this user."),
            ConversationOperationStatus.Conflict => Problem(StatusCodes.Status409Conflict, "Idempotency conflict", result.Detail),
            _ => Problem(StatusCodes.Status500InternalServerError, "Unexpected result", "The message could not be persisted.")
        };
    }

    private static bool TryGetUserId(HttpContext context, out Guid userId)
    {
        var value = context.User.FindFirstValue(ClaimTypes.NameIdentifier);
        return Guid.TryParse(value, out userId);
    }

    private static IResult Problem(int statusCode, string title, string? detail)
    {
        return Results.Problem(
            statusCode: statusCode,
            title: title,
            detail: detail,
            type: $"https://httpstatuses.com/{statusCode}");
    }

}
