namespace Jarvis.Api.Authentication;

public static class AuthenticationConstants
{
    public const string UiScheme = "LocalBearer";
    public const string MobileScheme = "MobileBearer";
    public const string DeviceScheme = "DeviceCredential";
    public const string DevicePolicy = "DeviceOnly";
    public const string UiPolicy = "UiAuthenticated";
    public const string LocalOnlyPolicy = "LocalOnly";
    public const string MobileOnlyPolicy = "MobileOnly";
    public const string MobileSessionClaim = "mobile_session_id";
    public const string MobileDeviceClaim = "mobile_device_id";
}
