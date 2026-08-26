using System.Security.Claims;
using System.Text.Encodings.Web;
using Jarvis.Application.Devices;
using Microsoft.AspNetCore.Authentication;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.Options;

namespace Jarvis.Api.Authentication;

public sealed class DeviceCredentialAuthenticationHandler(
    IOptionsMonitor<AuthenticationSchemeOptions> schemeOptions,
    ILoggerFactory logger,
    UrlEncoder encoder,
    IDeviceStore devices)
    : AuthenticationHandler<AuthenticationSchemeOptions>(schemeOptions, logger, encoder)
{
    protected override async Task<AuthenticateResult> HandleAuthenticateAsync()
    {
        string? suppliedCredential = null;
        if (Request.Headers.TryGetValue("Authorization", out var authorization))
        {
            const string prefix = "Bearer ";
            var value = authorization.ToString();
            if (!value.StartsWith(prefix, StringComparison.OrdinalIgnoreCase))
            {
                return AuthenticateResult.Fail("Invalid authorization scheme.");
            }

            suppliedCredential = value[prefix.Length..].Trim();
        }
        else if (Request.Path.StartsWithSegments("/hubs/device")
            && Request.Query.TryGetValue("access_token", out var accessToken))
        {
            suppliedCredential = accessToken.ToString();
        }

        if (string.IsNullOrWhiteSpace(suppliedCredential))
        {
            return AuthenticateResult.NoResult();
        }

        var device = await devices.AuthenticateAsync(suppliedCredential, Context.RequestAborted);
        if (device is null)
        {
            return AuthenticateResult.Fail("Invalid device credential.");
        }

        var claims = new[]
        {
            new Claim(ClaimTypes.NameIdentifier, device.DeviceId.ToString("D")),
            new Claim(ClaimTypes.Name, "device-node"),
            new Claim("device_user_id", device.UserId.ToString("D"))
        };
        var identity = new ClaimsIdentity(claims, Scheme.Name);
        return AuthenticateResult.Success(new AuthenticationTicket(new ClaimsPrincipal(identity), Scheme.Name));
    }

    protected override async Task HandleChallengeAsync(AuthenticationProperties properties)
    {
        Response.StatusCode = StatusCodes.Status401Unauthorized;
        await Response.WriteAsJsonAsync(
            new ProblemDetails
            {
                Status = StatusCodes.Status401Unauthorized,
                Title = "Unauthorized",
                Detail = "A registered device credential is required."
            },
            options: null,
            contentType: "application/problem+json",
            cancellationToken: Context.RequestAborted);
    }
}
