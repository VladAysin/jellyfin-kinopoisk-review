using System.Net;
using Jellyfin.Plugin.KinopoiskRatings;

await TransportTests.RunAsync();
await WebIntegrationTests.RunAsync();
var root = Path.Combine(Path.GetTempPath(), "kinopoisk-tests-" + Guid.NewGuid());
Directory.CreateDirectory(root);
try
{
    var store = new RatingStore(root);
    var user = Guid.NewGuid();
    var other = Guid.NewGuid();
    var entry = new RatingEntry { UserId = user, ItemId = Guid.NewGuid(), Title = "Test", KinopoiskId = "123", Kind = "movie" };
    store.Enqueue(entry);
    store.Enqueue(entry with { Id = Guid.NewGuid() });
    Check(store.Queue(user).Length == 1, "Deduplicate repeated playback");
    Check(store.Queue(other).Length == 0 && store.Find(other, entry.Id) == null, "User isolation");
    store.Connect(user, "session=private-test-value");
    Check(!File.ReadAllText(Path.Combine(root, "state.json")).Contains("private-test-value"), "No plaintext cookie");
    store = new RatingStore(root);
    Check(store.Cookie(user) == "session=private-test-value", "Cookie survives restart");
    Check(store.Queue(user).Length == 1, "Queue survives restart");
    var handler = new VoteHandler();
    using var client = new KinopoiskClient(handler);
    var service = new RatingService(store, client);
    await ExpectFailure(() => service.Rate(other, entry.Id, 7, default));
    Check(handler.Requests == 0, "Cross-user request never leaves server");
    await ExpectFailure(() => service.Rate(user, entry.Id, 11, default));
    Check(handler.Requests == 0, "Invalid rating never leaves server");
    handler.Fail = true;
    await ExpectFailure(() => service.Rate(user, entry.Id, 7, default));
    Check(store.Find(user, entry.Id) is { Status: "failed", Rating: 7 }, "Failed vote remains pending");
    handler.Fail = false;
    await Task.WhenAll(service.Rate(user, entry.Id, 7, default), service.Rate(user, entry.Id, 7, default));
    Check(handler.Requests == 2, "Concurrent duplicate votes sent once, plus previous failed request");
    Check(store.Find(user, entry.Id)?.Status == "sent" && store.Queue(user).Length == 0, "Confirmed vote removed from queue");
    var later = entry with { Id = Guid.NewGuid(), KinopoiskId = "456" };
    store.Enqueue(later);
    await service.Dismiss(user, later.Id, true, default);
    Check(store.Queue(user).Length == 0, "Defer persists and hides entry");
    await service.Dismiss(user, later.Id, false, default);
    Check(store.Find(user, later.Id)?.Status == "dismissed", "Permanent dismiss");
    await service.Disconnect(user, default);
    Check(!new RatingStore(root).Connected(user), "Disconnect persists");
    Console.WriteLine("Backend persistence, isolation and rating tests passed.");
}
finally { Directory.Delete(root, true); }

static void Check(bool condition, string message) { if (!condition) throw new Exception(message); }
static async Task ExpectFailure(Func<Task> action)
{
    try { await action(); } catch { return; }
    throw new Exception("Expected failure");
}

sealed class VoteHandler : HttpMessageHandler
{
    public bool Fail { get; set; }
    public int Requests { get; private set; }
    protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
    {
        Requests++;
        return Task.FromResult(new HttpResponseMessage(Fail ? HttpStatusCode.ServiceUnavailable : HttpStatusCode.OK)
        { Content = new StringContent("{\"data\":{\"movie\":{\"vote\":{\"set\":{\"error\":null,\"status\":\"SUCCESS\"}}}}}") });
    }
}
