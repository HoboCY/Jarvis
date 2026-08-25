using System.Text.Json;
using System.Text.Json.Serialization;
using Jarvis.Api.Authentication;
using Jarvis.Api.Conversations;
using Jarvis.Api.Outbox;
using Jarvis.Api.Realtime;
using Jarvis.Application.Outbox;
using Jarvis.Contracts;
using Jarvis.Infrastructure;
using Jarvis.Infrastructure.Data;
using Microsoft.AspNetCore.Authentication;
using Microsoft.OpenApi;

var builder = WebApplication.CreateBuilder(args);

builder.Services.AddProblemDetails();
builder.Services.AddOpenApi(options =>
{
    options.AddDocumentTransformer((document, _, _) =>
    {
        document.Components ??= new OpenApiComponents();
        document.Components.SecuritySchemes ??= new Dictionary<string, IOpenApiSecurityScheme>();
        document.Components.SecuritySchemes["LocalBearer"] = new OpenApiSecurityScheme
        {
            Type = SecuritySchemeType.Http,
            Scheme = "bearer"
        };
        return Task.CompletedTask;
    });
    options.AddOperationTransformer((operation, _, _) =>
    {
        if (operation.OperationId is "CreateConversation" or "AddTypedConversationMessage")
        {
            operation.Parameters ??= [];
            operation.Parameters.Add(new OpenApiParameter
            {
                Name = "Idempotency-Key",
                In = ParameterLocation.Header,
                Required = true,
                Schema = new OpenApiSchema { Type = JsonSchemaType.String }
            });
        }

        return Task.CompletedTask;
    });
    options.AddOperationTransformer((operation, context, _) =>
    {
        if (context.Description.RelativePath?.StartsWith(
                "api/v1/conversations",
                StringComparison.OrdinalIgnoreCase) == true)
        {
            operation.Security =
            [
                new OpenApiSecurityRequirement
                {
                    [new OpenApiSecuritySchemeReference("LocalBearer", context.Document, null)] = []
                }
            ];
        }

        return Task.CompletedTask;
    });
});
builder.Services.AddJarvisInfrastructure(builder.Configuration);
builder.Services.AddSingleton<IOutboxPublisher, SignalRNotificationPublisher>();
builder.Services
    .AddOptions<LocalBearerTokenOptions>()
    .Bind(builder.Configuration.GetSection(LocalBearerTokenOptions.SectionName))
    .Validate(
        options => options.BearerToken.Length >= 32,
        "Authentication:BearerToken must be configured and contain at least 32 characters.")
    .ValidateOnStart();
builder.Services
    .AddAuthentication("LocalBearer")
    .AddScheme<AuthenticationSchemeOptions, LocalBearerAuthenticationHandler>("LocalBearer", _ => { });
builder.Services.AddAuthorization();
builder.Services.AddSignalR();
builder.Services.ConfigureHttpJsonOptions(options =>
{
    options.SerializerOptions.PropertyNamingPolicy = JsonNamingPolicy.CamelCase;
    options.SerializerOptions.DictionaryKeyPolicy = JsonNamingPolicy.CamelCase;
    options.SerializerOptions.Converters.Add(new JsonStringEnumConverter(JsonNamingPolicy.CamelCase));
});

var app = builder.Build();

app.UseExceptionHandler();
app.UseAuthentication();
app.UseAuthorization();
app.MapOpenApi();

app.MapGet("/api/v1/phase0/health", () =>
        TypedResults.Ok(new Phase0HealthResponse(Phase0Status.Ready, "phase-0")))
    .WithName("Phase0Health")
        .WithSummary("Returns the Phase 0 service health contract.")
        .Produces<Phase0HealthResponse>();

app.MapConversationEndpoints();
app.MapHub<ClientHub>("/hubs/client").RequireAuthorization();

await using (var scope = app.Services.CreateAsyncScope())
{
    await scope.ServiceProvider.GetRequiredService<DatabaseInitializer>().InitializeAsync();
}

app.Run();

public partial class Program;
