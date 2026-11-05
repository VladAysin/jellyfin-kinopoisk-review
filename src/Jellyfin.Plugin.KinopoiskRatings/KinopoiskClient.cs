using System.Globalization;
using System.Net;
using System.Net.Http;
using System.Net.Http.Json;
using System.Text.Json;

namespace Jellyfin.Plugin.KinopoiskRatings;

/// <summary>Private Kinopoisk web protocol. No requests are retried automatically.</summary>
public sealed class KinopoiskClient : IDisposable
{
    private const string Endpoint = "https://graphql.kinopoisk.ru/graphql/";
    // The service accepts its web client's exact operation documents.
    private const string ProfileQuery = "query UserProfileModerator { userProfile { ...UserId ... on UserProfile { roles { moderator __typename } __typename } __typename } } fragment UserId on UserProfileInterface { id { ottId kpId puid __typename } __typename } ";
    private const string SetVoteMutation = "mutation MovieSetVote($movieId: Long!, $rate: Int!) {\n  movie {\n    vote {\n      set(input: {movieId: $movieId, rate: $rate}) {\n        error {\n          message\n          __typename\n        }\n        status\n        __typename\n      }\n      __typename\n    }\n    __typename\n  }\n}\n";
    private readonly HttpClient _http;

    public KinopoiskClient() : this(new HttpClientHandler
    {
        UseCookies = false,
        AllowAutoRedirect = false,
        AutomaticDecompression = DecompressionMethods.GZip | DecompressionMethods.Deflate
    }) { }

    /// <summary>The injected handler is owned and disposed by this client.</summary>
    public KinopoiskClient(HttpMessageHandler handler)
    {
        _http = new HttpClient(handler) { Timeout = TimeSpan.FromSeconds(25), MaxResponseContentBufferSize = 1024 * 1024 };
    }

    public async Task<string> VerifyAsync(string cookie, CancellationToken ct = default)
    {
        using var document = await SendAsync(cookie, "UserProfileModerator", ProfileQuery, new { }, false, ct).ConfigureAwait(false);
        var id = At(document.RootElement, "data", "userProfile", "id", "kpId");
        var text = id.ValueKind == JsonValueKind.String ? id.GetString() : id.ValueKind == JsonValueKind.Number ? id.GetRawText() : null;
        if (!long.TryParse(text, NumberStyles.None, CultureInfo.InvariantCulture, out var numericId) || numericId <= 0)
            throw new KinopoiskException("Кинопоиск не подтвердил вход. Обновите Cookie из авторизованной сессии Кинопоиска.");
        return numericId.ToString(CultureInfo.InvariantCulture);
    }

    public async Task RateAsync(string cookie, string movieId, int rating, CancellationToken ct = default)
    {
        if (rating is < 1 or > 10)
            throw new ArgumentOutOfRangeException(nameof(rating), "Оценка должна быть от 1 до 10.");
        if (!long.TryParse(movieId, NumberStyles.None, CultureInfo.InvariantCulture, out var id) || id <= 0)
            throw new ArgumentException("Не указан корректный идентификатор Кинопоиска.", nameof(movieId));

        using var document = await SendAsync(cookie, "MovieSetVote", SetVoteMutation, new { movieId = id, rate = rating }, true, ct).ConfigureAwait(false);
        var result = At(document.RootElement, "data", "movie", "vote", "set");
        var error = At(result, "error");
        var status = At(result, "status");
        // Missing or unknown data never counts as a successful write.
        if (error.ValueKind != JsonValueKind.Null || status.ValueKind != JsonValueKind.String || status.GetString() != "SUCCESS")
            throw new KinopoiskException("Кинопоиск не подтвердил сохранение оценки. Проверьте оценку на сайте перед повторной отправкой.");
    }

    private async Task<JsonDocument> SendAsync(string cookie, string operationName, string query, object variables, bool write, CancellationToken ct)
    {
        ValidateCookie(cookie);
        using var request = new HttpRequestMessage(HttpMethod.Post, Endpoint + "?operationName=" + operationName);
        request.Headers.Add("Cookie", cookie);
        request.Headers.Add("Origin", "https://www.kinopoisk.ru");
        request.Headers.Referrer = new Uri("https://www.kinopoisk.ru/");
        request.Headers.Add("service-id", "25");
        request.Headers.Add("x-preferred-language", "ru");
        if (write) request.Headers.Add("source-id", "1");
        request.Content = JsonContent.Create(new { operationName, variables, query });

        try
        {
            using var response = await _http.SendAsync(request, HttpCompletionOption.ResponseContentRead, ct).ConfigureAwait(false);
            if (response.StatusCode is HttpStatusCode.Unauthorized or HttpStatusCode.Forbidden)
                throw new KinopoiskException("Кинопоиск отклонил запрос: сессия истекла или требуется проверка на сайте. Откройте Кинопоиск и обновите подключение.");
            if (response.StatusCode == HttpStatusCode.TooManyRequests)
                throw new KinopoiskException("Кинопоиск ограничил частоту запросов. Попробуйте позднее.");
            if (!response.IsSuccessStatusCode)
                throw new KinopoiskException($"Кинопоиск вернул HTTP {(int)response.StatusCode}. Сохранение оценки не подтверждено.");

            var document = JsonDocument.Parse(await response.Content.ReadAsStringAsync(ct).ConfigureAwait(false));
            var errors = At(document.RootElement, "errors");
            if ((errors.ValueKind == JsonValueKind.Array && errors.GetArrayLength() > 0)
                || (errors.ValueKind != JsonValueKind.Array && errors.ValueKind != JsonValueKind.Undefined && errors.ValueKind != JsonValueKind.Null))
            {
                document.Dispose();
                throw new KinopoiskException("Кинопоиск вернул ошибку API. Проверьте вход на сайте; возможно, изменился протокол интеграции.");
            }
            return document;
        }
        catch (OperationCanceledException) when (!ct.IsCancellationRequested)
        {
            throw new KinopoiskException("Кинопоиск не ответил вовремя. Результат неизвестен: проверьте оценку на сайте перед повтором.");
        }
        catch (HttpRequestException)
        {
            throw new KinopoiskException("Не удалось связаться с Кинопоиском. Результат неизвестен: проверьте оценку на сайте перед повтором.");
        }
        catch (JsonException)
        {
            throw new KinopoiskException("Получен неожиданный ответ Кинопоиска. Проверьте вход и наличие проверки на сайте.");
        }
    }

    private static void ValidateCookie(string cookie)
    {
        if (string.IsNullOrWhiteSpace(cookie) || cookie.Length > 32768 || cookie.Any(c => c < 0x20 || c > 0x7e))
            throw new KinopoiskException("Вставьте значение заголовка Cookie одной строкой, без названия заголовка.");
        foreach (var part in cookie.Split(';'))
        {
            var value = part.Trim();
            var equals = value.IndexOf('=');
            if (equals < 1 || value[..equals].Any(c => !char.IsAsciiLetterOrDigit(c) && !"!#$%&'*+-.^_`|~".Contains(c)))
                throw new KinopoiskException("Некорректное значение Cookie. Скопируйте только значение заголовка запроса Кинопоиска.");
        }
    }

    private static JsonElement At(JsonElement value, params string[] path)
    {
        foreach (var key in path)
        {
            if (value.ValueKind != JsonValueKind.Object || !value.TryGetProperty(key, out value)) return default;
        }
        return value;
    }

    public void Dispose() => _http.Dispose();
}

/// <summary>Safe to display; never contains upstream response bodies or session values.</summary>
public sealed class KinopoiskException(string message) : InvalidOperationException(message);
