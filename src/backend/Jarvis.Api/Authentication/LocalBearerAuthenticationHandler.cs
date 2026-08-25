using System.Security.Claims;
using System.Security.Cryptography;
using System.Text;
using System.Text.Encodings.Web;
using Jarvis.Application.Identity;
using Microsoft.AspNetCore.Authentication;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.Options;

namespace Jarvis.Api.Authentication;

public sealed class LocalBearerAuthenticationHandler(
    IOptionsMonitor<AuthenticationSchemeOptions> schemeOptions,
    ILoggerFactory logger,
    UrlEncoder encoder,
    IOptions<LocalBearerTokenOptions> tokenOptions,
    LocalUserIdentity localUser)
    : AuthenticationHandler<AuthenticationSchemeOptions>(schemeOptions, logger, encoder)
{
    protected override Task<AuthenticateResult> HandleAuthenticateAsync()
    {
        string? suppliedToken;
        if (Request.Headers.TryGetValue("Authorization", out var authorization))
        {
            const string prefix = "Bearer ";
            var value = authorization.ToString();
            if (!value.StartsWith(prefix, StringComparison.OrdinalIgnoreCase))
            {
                return Task.FromResult(AuthenticateResult.Fail("Invalid authorization scheme."));
            }

            suppliedToken = value[prefix.Length..].Trim();
        }
        else if (Request.Path.StartsWithSegments("/hubs/client")
            && Request.Query.TryGetValue("access_token", out var accessToken))
        {
            suppliedToken = accessToken.ToString();
        }
        else
        {
            return Task.FromResult(AuthenticateResult.NoResult());
        }

        var expectedToken = tokenOptions.Value.BearerToken;
        var suppliedHash = SHA256.HashData(Encoding.UTF8.GetBytes(suppliedToken));
        var expectedHash = SHA256.HashData(Encoding.UTF8.GetBytes(expectedToken));
        if (!CryptographicOperations.FixedTimeEquals(suppliedHash, expectedHash))
        {
            return Task.FromResult(AuthenticateResult.Fail("Invalid bearer token."));
        }

        if (localUser.UserId is not Guid userId)
        {
            return Task.FromResult(AuthenticateResult.Fail("The local user is not initialized."));
        }

        var claims = new[]
        {
            new Claim(ClaimTypes.NameIdentifier, userId.ToString("D")),
            new Claim(ClaimTypes.Name, "local-user")
        };
        var identity = new ClaimsIdentity(claims, Scheme.Name);
        var principal = new ClaimsPrincipal(identity);
        return Task.FromResult(AuthenticateResult.Success(new AuthenticationTicket(principal, Scheme.Name)));
    }

    protected override async Task HandleChallengeAsync(AuthenticationProperties properties)
    {
        Response.StatusCode = StatusCodes.Status401Unauthorized;
        await Response.WriteAsJsonAsync(
            new ProblemDetails
            {
                Status = StatusCodes.Status401Unauthorized,
                Title = "Unauthorized",
                Detail = "Authentication is required."
            },
            options: null,
            contentType: "application/problem+json",
            cancellationToken: Context.RequestAborted);
    }
}
