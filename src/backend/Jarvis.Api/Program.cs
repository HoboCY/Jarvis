using System.Text.Json;
using System.Text.Json.Serialization;
using Jarvis.Contracts;

var builder = WebApplication.CreateBuilder(args);

builder.Services.AddProblemDetails();
builder.Services.AddOpenApi();
builder.Services.ConfigureHttpJsonOptions(options =>
{
    options.SerializerOptions.PropertyNamingPolicy = JsonNamingPolicy.CamelCase;
    options.SerializerOptions.DictionaryKeyPolicy = JsonNamingPolicy.CamelCase;
    options.SerializerOptions.Converters.Add(new JsonStringEnumConverter(JsonNamingPolicy.CamelCase));
});

var app = builder.Build();

app.UseExceptionHandler();
app.MapOpenApi();

app.MapGet("/api/v1/phase0/health", () =>
        TypedResults.Ok(new Phase0HealthResponse(Phase0Status.Ready, "phase-0")))
    .WithName("Phase0Health")
    .WithSummary("Returns the Phase 0 service health contract.")
    .Produces<Phase0HealthResponse>();

app.Run();

public partial class Program;
