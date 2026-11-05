using MediaBrowser.Controller.Session;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;

namespace Jellyfin.Plugin.KinopoiskRatings;

[ApiController]
[Authorize]
[Route("KinopoiskRatings")]
public sealed class RatingsController(RatingStore store, RatingService service, ISessionManager sessions) : ControllerBase
{
    private Guid CurrentUser => Guid.TryParse(User.FindFirst("Jellyfin-UserId")?.Value, out var id) && id != Guid.Empty
        ? id : throw new UnauthorizedAccessException();

    [HttpGet("client.js")]
    [AllowAnonymous]
    public IActionResult Script()
    {
        var stream = typeof(Plugin).Assembly.GetManifestResourceStream("KinopoiskRatings.client.js")!;
        Response.Headers.CacheControl = "no-cache";
        return File(stream, "application/javascript; charset=utf-8");
    }

    [HttpGet("queue")]
    public IActionResult Queue() => Run(() => Ok(store.Queue(CurrentUser).Select(x => new
    { id = x.Id, title = x.Title, kinopoiskId = x.KinopoiskId, kind = x.Kind, rating = x.Rating, status = x.Status, error = x.Error })));

    [HttpGet("connection")]
    public IActionResult Connection() => Run(() => Ok(new { connected = store.Connected(CurrentUser) }));

    [HttpGet("playback-active")]
    public IActionResult Active() => Run(() =>
    {
        var user = CurrentUser;
        var device = User.FindFirst("Jellyfin-DeviceId")?.Value;
        return Ok(new { active = sessions.Sessions.Any(x => x.UserId == user &&
            (string.IsNullOrEmpty(device) || x.DeviceId == device) && x.NowPlayingItem != null) });
    });

    [HttpPut("connection")]
    [RequestSizeLimit(32768)]
    public Task<IActionResult> Connect([FromBody] ConnectionRequest request, CancellationToken ct) => RunAsync(async () =>
    {
        if (string.IsNullOrWhiteSpace(request.Cookie) || request.Cookie.Length > 24000) return BadRequest(new { error = "Укажите Cookie сессии Кинопоиска." });
        await service.Connect(CurrentUser, request.Cookie, ct);
        return Ok(new { connected = true });
    });

    [HttpDelete("connection")]
    public Task<IActionResult> Disconnect(CancellationToken ct) => RunAsync(async () =>
    { await service.Disconnect(CurrentUser, ct); return Ok(new { connected = false }); });

    [HttpPost("queue/{id:guid}/rate")]
    public Task<IActionResult> Rate(Guid id, [FromBody] RateRequest request, CancellationToken ct) => RunAsync(async () =>
    { await service.Rate(CurrentUser, id, request.Rating, ct); return Ok(new { status = "sent" }); });

    [HttpPost("queue/{id:guid}/dismiss")]
    public Task<IActionResult> Dismiss(Guid id, [FromBody] DismissRequest request, CancellationToken ct) => RunAsync(async () =>
    { await service.Dismiss(CurrentUser, id, request.Defer, ct); return Ok(new { status = request.Defer ? "deferred" : "dismissed" }); });

    private IActionResult Run(Func<IActionResult> action)
    {
        try { return action(); }
        catch (UnauthorizedAccessException) { return Unauthorized(); }
    }

    private async Task<IActionResult> RunAsync(Func<Task<IActionResult>> action)
    {
        try { return await action(); }
        catch (UnauthorizedAccessException) { return Unauthorized(); }
        catch (KeyNotFoundException) { return NotFound(); }
        catch (ArgumentException) { return BadRequest(new { error = "Проверьте введённые данные." }); }
        catch (InvalidOperationException ex) { return BadRequest(new { error = ex.Message }); }
        catch (OperationCanceledException) { return StatusCode(504, new { error = "Отправка не подтверждена. Проверьте оценку в Кинопоиске перед повтором." }); }
        catch (HttpRequestException) { return StatusCode(502, new { error = "Кинопоиск недоступен. Отправка не подтверждена." }); }
    }
}

public sealed record ConnectionRequest(string Cookie);
public sealed record RateRequest(int Rating);
public sealed record DismissRequest(bool Defer);
