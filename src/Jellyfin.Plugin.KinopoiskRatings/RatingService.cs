namespace Jellyfin.Plugin.KinopoiskRatings;

public sealed class RatingService(RatingStore store, KinopoiskClient client)
{
    // Serialize writes and disconnects, including multiple browser tabs.
    private readonly SemaphoreSlim _gate = new(1, 1);

    public async Task Connect(Guid user, string cookie, CancellationToken ct)
    {
        cookie = KinopoiskClient.NormalizeCookie(cookie);
        await _gate.WaitAsync(ct);
        try { await client.VerifyAsync(cookie, ct); store.Connect(user, cookie); }
        finally { _gate.Release(); }
    }

    public async Task Disconnect(Guid user, CancellationToken ct)
    {
        await _gate.WaitAsync(ct);
        try { store.Disconnect(user); }
        finally { _gate.Release(); }
    }

    public async Task Rate(Guid user, Guid id, int rating, CancellationToken ct)
    {
        if (rating is < 1 or > 10) throw new ArgumentException("Оценка должна быть от 1 до 10.");
        await _gate.WaitAsync(ct);
        try
        {
            var entry = store.Find(user, id) ?? throw new KeyNotFoundException();
            if (entry.Status == "sent" && entry.Rating == rating) return;
            if (entry.Status is "sent" or "dismissed") throw new InvalidOperationException("Эта запись уже закрыта.");
            var cookie = store.Cookie(user);
            store.Update(user, id, x => { x.Rating = rating; x.Status = "failed"; x.Error = "Отправка не подтверждена. Повторите вручную."; });
            await client.RateAsync(cookie, entry.KinopoiskId, rating, ct);
            store.Update(user, id, x => { x.Status = "sent"; x.Error = null; });
        }
        finally { _gate.Release(); }
    }

    public async Task Dismiss(Guid user, Guid id, bool defer, CancellationToken ct)
    {
        await _gate.WaitAsync(ct);
        try
        {
            var entry = store.Find(user, id) ?? throw new KeyNotFoundException();
            if (entry.Status is "sent" or "dismissed") return;
            store.Update(user, id, x => { if (defer) x.AvailableAt = DateTimeOffset.UtcNow.AddDays(1); else x.Status = "dismissed"; });
        }
        finally { _gate.Release(); }
    }
}
