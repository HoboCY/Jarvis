using System.Text.Json;
using System.Text.Json.Serialization;
using System.Security.Claims;
using Jarvis.Api.Authentication;
using Jarvis.Api.Conversations;
using Jarvis.Api.Approvals;
using Jarvis.Api.Devices;
using Jarvis.Api.Outbox;
using Jarvis.Api.Realtime;
using Jarvis.Api.Tasks;
using Jarvis.Api.Notifications;
using Jarvis.Api.Memory;
using Jarvis.Api.Mobile;
using Jarvis.Api.Observability;
using Jarvis.Api.Diagnostics;
using Jarvis.Application.Outbox;
using Jarvis.Application.Mobile;
using Jarvis.Contracts;
using Jarvis.Infrastructure;
using Jarvis.Infrastructure.Data;
using Jarvis.Infrastructure.Observability;
using System.Threading.RateLimiting;
using Microsoft.AspNetCore.Authentication;
using Microsoft.AspNetCore.Mvc;
using Microsoft.OpenApi;

var builder = WebApplication.CreateBuilder(args);

builder.Logging.ClearProviders();
builder.Logging.AddJarvisJsonConsole();
builder.Services.AddJarvisTelemetry(builder.Configuration, "jarvis.api", includeAspNetCoreInstrumentation: true);
builder.Services
    .AddOptions<DiagnosticsOptions>()
    .Bind(builder.Configuration.GetSection(DiagnosticsOptions.SectionName))
    .Validate(options => options.RequireLoopback, "Diagnostics:RequireLoopback must remain enabled.")
    .ValidateOnStart();
builder.Services.AddSingleton<DiagnosticsRegistry>();
builder.Services.AddScoped<DiagnosticsService>();

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
        document.Components.SecuritySchemes["DeviceBearer"] = new OpenApiSecurityScheme
        {
            Type = SecuritySchemeType.Http,
            Scheme = "bearer"
        };
        document.Components.SecuritySchemes["MobileBearer"] = new OpenApiSecurityScheme
        {
            Type = SecuritySchemeType.Http,
            Scheme = "bearer"
        };
        return Task.CompletedTask;
    });
    options.AddOperationTransformer((operation, context, _) =>
    {
        if (operation.OperationId is "CreateConversation"
            or "AddTypedConversationMessage"
            or "GetDesktopRealtimeDevice"
            or "CreateRealtimeClientSecret"
            or "MarkRealtimeSessionConnected"
            or "MarkRealtimeSessionEnded"
            or "IngestRealtimeEvents"
            or "CreateTask"
            or "CancelTask"
            or "SubmitTaskUserInput"
            or "MarkNotificationDelivered"
            or "MarkNotificationRead"
            or "DismissNotification"
            or "ApplyNotificationAction"
            or "CreateMemoryFact"
            or "RetractMemoryFact")
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

        if (operation.OperationId is "RegisterDevice"
            or "HeartbeatDevice"
            or "ClaimDeviceTask"
            or "AppendDeviceTaskEvent"
            or "RenewDeviceTaskLease"
            or "CreateDeviceApproval"
            or "CreateDeviceTaskUserInput"
            or "ResolveDeviceTaskUserInput"
            or "DecideApproval")
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
                StringComparison.OrdinalIgnoreCase) == true
            || context.Description.RelativePath?.StartsWith(
                "api/v1/realtime",
                StringComparison.OrdinalIgnoreCase) == true
            || context.Description.RelativePath?.StartsWith(
                "api/v1/tasks",
                StringComparison.OrdinalIgnoreCase) == true
            || context.Description.RelativePath?.StartsWith(
                "api/v1/notifications",
                StringComparison.OrdinalIgnoreCase) == true
            || context.Description.RelativePath?.StartsWith(
                "api/v1/memory-facts",
                StringComparison.OrdinalIgnoreCase) == true
            || context.Description.RelativePath?.StartsWith(
                "api/v1/devices/register",
                StringComparison.OrdinalIgnoreCase) == true
            || context.Description.RelativePath?.Equals(
                "api/v1/devices",
                StringComparison.OrdinalIgnoreCase) == true
            || context.Description.RelativePath?.Equals(
                "api/v1/diagnostics",
                StringComparison.OrdinalIgnoreCase) == true
            || context.Description.RelativePath?.StartsWith(
                "health/",
                StringComparison.OrdinalIgnoreCase) == true)
        {
            operation.Security =
            [
                new OpenApiSecurityRequirement
                {
                    [new OpenApiSecuritySchemeReference("LocalBearer", context.Document, null)] = []
                },
                new OpenApiSecurityRequirement
                {
                    [new OpenApiSecuritySchemeReference("MobileBearer", context.Document, null)] = []
                }
            ];
        }

        if (context.Description.RelativePath?.StartsWith("api/v1/approvals", StringComparison.OrdinalIgnoreCase) == true)
        {
            operation.Security =
            [
                new OpenApiSecurityRequirement
                {
                    [new OpenApiSecuritySchemeReference("LocalBearer", context.Document, null)] = []
                },
                new OpenApiSecurityRequirement
                {
                    [new OpenApiSecuritySchemeReference("MobileBearer", context.Document, null)] = []
                }
            ];
        }

        if (context.Description.RelativePath?.Equals("api/v1/mobile-pairings", StringComparison.OrdinalIgnoreCase) == true)
        {
            operation.Security =
            [
                new OpenApiSecurityRequirement
                {
                    [new OpenApiSecuritySchemeReference("LocalBearer", context.Document, null)] = []
                }
            ];
        }

        if (context.Description.RelativePath?.Equals("api/v1/mobile-sessions/revoke", StringComparison.OrdinalIgnoreCase) == true)
        {
            operation.Security =
            [
                new OpenApiSecurityRequirement
                {
                    [new OpenApiSecuritySchemeReference("MobileBearer", context.Document, null)] = []
                }
            ];
        }

        if (context.Description.RelativePath?.Equals("api/v1/realtime/desktop-device", StringComparison.OrdinalIgnoreCase) == true)
        {
            operation.Security =
            [
                new OpenApiSecurityRequirement
                {
                    [new OpenApiSecuritySchemeReference("LocalBearer", context.Document, null)] = []
                }
            ];
        }

        if (context.Description.RelativePath?.StartsWith("api/v1/devices/{deviceId", StringComparison.OrdinalIgnoreCase) == true
            || context.Description.RelativePath?.StartsWith("api/v1/device-tasks", StringComparison.OrdinalIgnoreCase) == true)
        {
            operation.Security =
            [
                new OpenApiSecurityRequirement
                {
                    [new OpenApiSecuritySchemeReference("DeviceBearer", context.Document, null)] = []
                }
            ];
        }

        return Task.CompletedTask;
    });
});
builder.Services.AddJarvisInfrastructure(builder.Configuration);
builder.Services.AddSingleton<IRuntimeStateObserver>(serviceProvider =>
    serviceProvider.GetRequiredService<DiagnosticsRegistry>());
builder.Services.AddSingleton<IOutboxPublisher, SignalRNotificationPublisher>();
builder.Services
    .AddOptions<LocalBearerTokenOptions>()
    .Bind(builder.Configuration.GetSection(LocalBearerTokenOptions.SectionName))
    .Validate(
        options => options.BearerToken.Length >= 32,
        "Authentication:BearerToken must be configured and contain at least 32 characters.")
    .ValidateOnStart();
builder.Services
    .AddAuthentication(AuthenticationConstants.UiScheme)
    .AddScheme<AuthenticationSchemeOptions, LocalBearerAuthenticationHandler>(AuthenticationConstants.UiScheme, _ => { })
    .AddScheme<AuthenticationSchemeOptions, MobileBearerAuthenticationHandler>(AuthenticationConstants.MobileScheme, _ => { })
    .AddScheme<AuthenticationSchemeOptions, DeviceCredentialAuthenticationHandler>(AuthenticationConstants.DeviceScheme, _ => { });
builder.Services.AddAuthorization(options =>
{
    options.DefaultPolicy = new Microsoft.AspNetCore.Authorization.AuthorizationPolicyBuilder(
            AuthenticationConstants.UiScheme,
            AuthenticationConstants.MobileScheme)
        .RequireAuthenticatedUser()
        .Build();
    options.AddPolicy(AuthenticationConstants.UiPolicy, policy =>
    {
        policy.AddAuthenticationSchemes(AuthenticationConstants.UiScheme, AuthenticationConstants.MobileScheme);
        policy.RequireAuthenticatedUser();
    });
    options.AddPolicy(AuthenticationConstants.LocalOnlyPolicy, policy =>
    {
        policy.AddAuthenticationSchemes(AuthenticationConstants.UiScheme);
        policy.RequireAuthenticatedUser();
    });
    options.AddPolicy(AuthenticationConstants.MobileOnlyPolicy, policy =>
    {
        policy.AddAuthenticationSchemes(AuthenticationConstants.MobileScheme);
        policy.RequireAuthenticatedUser();
    });
    options.AddPolicy(AuthenticationConstants.DevicePolicy, policy =>
    {
        policy.AddAuthenticationSchemes(AuthenticationConstants.DeviceScheme);
        policy.RequireAuthenticatedUser();
    });
});
builder.Services.AddRateLimiter(options =>
{
    options.RejectionStatusCode = StatusCodes.Status429TooManyRequests;
    options.OnRejected = async (context, cancellationToken) =>
    {
        await context.HttpContext.Response.WriteAsJsonAsync(
            new ProblemDetails
            {
                Status = StatusCodes.Status429TooManyRequests,
                Title = "Realtime client-secret rate limit exceeded",
                Detail = "Too many realtime client-secret requests were made for this Desktop device."
            },
            options: null,
            contentType: "application/problem+json",
            cancellationToken);
    };
    options.AddPolicy("realtime-client-secret", context =>
        RateLimitPartition.GetFixedWindowLimiter(
            // Phase 2 exposes one seeded Desktop device per local user; keep the
            // device dimension explicit so Phase 4 can replace the suffix with
            // a registered device identity without changing this policy.
            $"{context.User.FindFirstValue(ClaimTypes.NameIdentifier) ?? context.Connection.RemoteIpAddress?.ToString() ?? "anonymous"}:desktop",
            _ => new FixedWindowRateLimiterOptions
            {
                PermitLimit = 10,
                Window = TimeSpan.FromMinutes(1),
                QueueLimit = 0,
                AutoReplenishment = true
            }));
    options.AddPolicy("mobile-pairing-exchange", context =>
        RateLimitPartition.GetFixedWindowLimiter(
            context.Connection.RemoteIpAddress?.ToString() ?? "anonymous",
            _ => new FixedWindowRateLimiterOptions
            {
                PermitLimit = context.RequestServices
                    .GetRequiredService<Microsoft.Extensions.Options.IOptions<MobileSessionOptions>>()
                    .Value.ExchangePermitLimit,
                Window = TimeSpan.FromMinutes(1),
                QueueLimit = 0,
                AutoReplenishment = true
            }));
    options.AddPolicy("mobile-session-refresh", context =>
        RateLimitPartition.GetFixedWindowLimiter(
            context.Connection.RemoteIpAddress?.ToString() ?? "anonymous",
            _ => new FixedWindowRateLimiterOptions
            {
                PermitLimit = context.RequestServices
                    .GetRequiredService<Microsoft.Extensions.Options.IOptions<MobileSessionOptions>>()
                    .Value.RefreshPermitLimit,
                Window = TimeSpan.FromMinutes(1),
                QueueLimit = 0,
                AutoReplenishment = true
            }));
});
builder.Services.AddSignalR();
builder.Services.ConfigureHttpJsonOptions(options =>
{
    options.SerializerOptions.PropertyNamingPolicy = JsonNamingPolicy.CamelCase;
    options.SerializerOptions.DictionaryKeyPolicy = JsonNamingPolicy.CamelCase;
    options.SerializerOptions.Converters.Add(new JsonStringEnumConverter(JsonNamingPolicy.CamelCase));
});

var app = builder.Build();

app.UseJarvisCorrelationId();
app.UseExceptionHandler();
app.UseAuthentication();
app.UseAuthorization();
app.UseRateLimiter();
app.MapOpenApi();
app.MapDiagnosticsEndpoints();

app.MapGet("/api/v1/phase0/health", () =>
        TypedResults.Ok(new Phase0HealthResponse(Phase0Status.Ready, "phase-0")))
    .WithName("Phase0Health")
        .WithSummary("Returns the Phase 0 service health contract.")
        .Produces<Phase0HealthResponse>();

app.MapConversationEndpoints();
app.MapRealtimeEndpoints();
app.MapTaskEndpoints();
app.MapNotificationEndpoints();
app.MapMemoryEndpoints();
app.MapApprovalEndpoints();
app.MapDeviceEndpoints();
app.MapMobilePairingEndpoints();
app.MapHub<ClientHub>("/hubs/client").RequireAuthorization();
app.MapHub<DeviceHub>("/hubs/device").RequireAuthorization(AuthenticationConstants.DevicePolicy);

await using (var scope = app.Services.CreateAsyncScope())
{
    await scope.ServiceProvider.GetRequiredService<DatabaseInitializer>().InitializeAsync();
}

app.Run();

public partial class Program;
