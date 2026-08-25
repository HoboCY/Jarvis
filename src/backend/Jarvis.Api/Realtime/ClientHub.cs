using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.SignalR;

namespace Jarvis.Api.Realtime;

[Authorize]
public sealed class ClientHub : Hub;
