using System.Security.Claims;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.SignalR;

namespace Jarvis.Api.Realtime;

[Authorize(Policy = "DeviceOnly")]
public sealed class DeviceHub : Hub
{
    public override async Task OnConnectedAsync()
    {
        if (Guid.TryParse(Context.User?.FindFirstValue("device_user_id"), out var userId))
        {
            await Groups.AddToGroupAsync(Context.ConnectionId, UserGroup(userId));
        }

        await base.OnConnectedAsync();
    }

    public static string UserGroup(Guid userId) => $"device-user:{userId:D}";
}
