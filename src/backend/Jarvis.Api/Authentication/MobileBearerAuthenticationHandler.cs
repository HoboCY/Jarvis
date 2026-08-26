using System.Security.Claims;
using System.Text.Encodings.Web;
using Jarvis.Application.Mobile;
using Microsoft.AspNetCore.Authentication;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.Options;

namespace Jarvis.Api.Authentication;

public sealed class MobileBearerAuthenticationHandler(
    IOptionsMonitor<AuthenticationSchemeOptions> schemeOptions,
    ILoggerFactory logger,
    UrlEncoder encoder,
    IMobileAccessTokenStore accessTokens,
    TimeProvider timeProvider)
    : AuthenticationHandler<AuthenticationSchemeOptions>(schemeOptions, logger, encoder)
{
    protected override Task<AuthenticateResult> HandleAuthenticateAsync()
    {
        var suppliedToken = Request.Headers.Authorization.ToString();
        if (string.IsNullOrWhiteSpace(suppliedToken)
            && Request.Path.StartsWithSegments("/hubs/client")
            && Request.Query.TryGetValue("access_token", out var accessToken))
        {
            suppliedToken = accessToken.ToString();
        }
        else if (suppliedToken.StartsWith("Bearer ", StringComparison.OrdinalIgnoreCase))
        {
            suppliedToken = suppliedToken["Bearer ".Length..].Trim();
        }
        else if (!string.IsNullOrWhiteSpace(suppliedToken))
        {
            return Task.FromResult(AuthenticateResult.NoResult());
        }

        if (string.IsNullOrWhiteSpace(suppliedToken)
            || !accessTokens.TryGet(
                suppliedToken,
                timeProvider.GetUtcNow().ToUnixTimeMilliseconds(),
                out var access))
        {
            return Task.FromResult(AuthenticateResult.NoResult());
        }

        var claims = new[]
        {
            new Claim(ClaimTypes.NameIdentifier, access.UserId.ToString("D")),
            new Claim(ClaimTypes.Name, "mobile-user"),
            new Claim(AuthenticationConstants.MobileSessionClaim, access.SessionId.ToString("D")),
            new Claim(AuthenticationConstants.MobileDeviceClaim, access.DeviceId.ToString("D"))
        };
        var identity = new ClaimsIdentity(claims, Scheme.Name);
        return Task.FromResult(AuthenticateResult.Success(new AuthenticationTicket(new ClaimsPrincipal(identity), Scheme.Name)));
    }

    protected override async Task HandleChallengeAsync(AuthenticationProperties properties)
    {
        if (Response.HasStarted)
        {
            return;
        }

        Response.StatusCode = StatusCodes.Status401Unauthorized;
        await Response.WriteAsJsonAsync(
            new ProblemDetails
            {
                Status = StatusCodes.Status401Unauthorized,
                Title = "Unauthorized",
                Detail = "A valid mobile session is required."
            },
            options: null,
            contentType: "application/problem+json",
            cancellationToken: Context.RequestAborted);
    }
}
