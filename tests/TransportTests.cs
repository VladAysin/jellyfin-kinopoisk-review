using System.Net;
using System.Text;
using System.Text.Json;
using Jellyfin.Plugin.KinopoiskRatings;

internal static class TransportTests
{
    public static async Task RunAsync()
    {
        var handler = new FakeHandler();
        using var client = new KinopoiskClient(handler);
        handler.Response = "{\"data\":{\"userProfile\":{\"id\":{\"kpId\":123}}}}";
        Assert(await client.VerifyAsync("Session_id=secret") == "123", "Profile identifies authenticated user");
        Assert(handler.Uri == "https://graphql.kinopoisk.ru/graphql/?operationName=UserProfileModerator", "Fixed endpoint");
        Assert(handler.Cookie == "Session_id=secret", "Session sent to provider");
        Assert(handler.Origin == "https://www.kinopoisk.ru", "Origin provided");

        handler.Response = "{\"data\":{\"movie\":{\"vote\":{\"set\":{\"error\":null,\"status\":\"SUCCESS\"}}}}}";
        await client.RateAsync("Session_id=secret", "326", 8);
        using (var request = JsonDocument.Parse(handler.Body!))
        {
            Assert(request.RootElement.GetProperty("variables").GetProperty("movieId").GetInt64() == 326, "Provider id sent as number");
            Assert(request.RootElement.GetProperty("variables").GetProperty("rate").GetInt32() == 8, "Chosen score sent");
        }
        Assert(handler.SourceId == "1", "Vote source header");

        foreach (var body in new[]
        {
            "{}",
            "{\"data\":{\"movie\":{\"vote\":{\"set\":{\"error\":null}}}}}",
            "{\"data\":{\"movie\":{\"vote\":{\"set\":{\"error\":null,\"status\":\"FAIL\"}}}}}",
            "{\"data\":{\"movie\":{\"vote\":{\"set\":{\"error\":{\"message\":\"secret\"},\"status\":\"SUCCESS\"}}}}}",
            "{\"errors\":[{\"message\":\"secret\"}]}",
            "<html>captcha secret</html>"
        })
        {
            handler.Response = body;
            await ExpectSafeFailure(() => client.RateAsync("Session_id=secret", "326", 8));
        }

        foreach (var status in new[] { HttpStatusCode.Forbidden, HttpStatusCode.TooManyRequests, HttpStatusCode.Redirect, HttpStatusCode.InternalServerError })
        {
            handler.Status = status;
            var before = handler.Calls;
            await ExpectSafeFailure(() => client.RateAsync("Session_id=secret", "326", 8));
            Assert(handler.Calls == before + 1, "No retries on remote errors");
        }
        handler.Status = HttpStatusCode.OK;
        handler.Response = "{\"data\":{\"userProfile\":{\"id\":{\"kpId\":null}}}}";
        await ExpectSafeFailure(() => client.VerifyAsync("Session_id=secret"));
        var callCount = handler.Calls;
        await ExpectSafeFailure(() => client.VerifyAsync("Session_id=secret\r\nHost: attacker"));
        await ExpectSafeFailure(() => client.VerifyAsync("Cookie: Session_id=secret"));
        Assert(handler.Calls == callCount, "Malformed cookies rejected before network");
        try { await client.RateAsync("Session_id=secret", "326", 11); throw new Exception("Accepted invalid rating"); }
        catch (ArgumentOutOfRangeException) { }
        Assert(handler.Calls == callCount, "Invalid score rejected before network");
        Console.WriteLine("Transport tests passed.");
    }

    private static async Task ExpectSafeFailure(Func<Task> action)
    {
        try { await action(); }
        catch (KinopoiskException exception)
        {
            Assert(!exception.ToString().Contains("secret", StringComparison.Ordinal), "No upstream secrets in exceptions");
            return;
        }
        throw new Exception("Expected safe provider failure");
    }

    private static void Assert(bool success, string message)
    {
        if (!success) throw new Exception(message);
    }

    private sealed class FakeHandler : HttpMessageHandler
    {
        public int Calls { get; private set; }
        public string Response { get; set; } = "{}";
        public HttpStatusCode Status { get; set; } = HttpStatusCode.OK;
        public string? Uri { get; private set; }
        public string? Cookie { get; private set; }
        public string? Origin { get; private set; }
        public string? SourceId { get; private set; }
        public string? Body { get; private set; }

        protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken ct)
        {
            Calls++;
            Uri = request.RequestUri!.ToString();
            Cookie = string.Join(";", request.Headers.GetValues("Cookie"));
            Origin = string.Join(";", request.Headers.GetValues("Origin"));
            SourceId = request.Headers.TryGetValues("source-id", out var values) ? string.Join(";", values) : null;
            Body = await request.Content!.ReadAsStringAsync(ct);
            return new HttpResponseMessage(Status) { Content = new StringContent(Response, Encoding.UTF8, "application/json") };
        }
    }
}
