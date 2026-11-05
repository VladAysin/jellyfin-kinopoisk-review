using System.Text.Json;
using MediaBrowser.Common.Configuration;
using Microsoft.AspNetCore.DataProtection;

namespace Jellyfin.Plugin.KinopoiskRatings;

public sealed record RatingEntry
{
    public Guid Id { get; init; } = Guid.NewGuid();
    public Guid UserId { get; init; }
    public Guid ItemId { get; init; }
    public required string Title { get; init; }
    public required string KinopoiskId { get; init; }
    public required string Kind { get; init; }
    public string Status { get; set; } = "pending";
    public int? Rating { get; set; }
    public string? Error { get; set; }
    public DateTimeOffset AvailableAt { get; set; } = DateTimeOffset.UtcNow;
}

public sealed class RatingState
{
    public List<RatingEntry> Entries { get; set; } = [];
    public Dictionary<Guid, string> Connections { get; set; } = [];
}

// A single lock covers disk commits. Return copies so readers cannot mutate committed state.
public sealed class RatingStore
{
    private readonly object _gate = new();
    private readonly string _path;
    private readonly IDataProtector _protector;
    private RatingState _state;

    public RatingStore(IApplicationPaths paths) : this(Path.Combine(paths.DataPath, "kinopoisk-ratings")) { }

    public RatingStore(string directory)
    {
        Directory.CreateDirectory(directory);
        _path = Path.Combine(directory, "state.json");
        _protector = DataProtectionProvider.Create(new DirectoryInfo(Path.Combine(directory, "keys")),
            options => options.SetApplicationName("Jellyfin.KinopoiskRatings")).CreateProtector("UserCookies.v1");
        // Do not silently overwrite a damaged state file.
        _state = File.Exists(_path)
            ? JsonSerializer.Deserialize<RatingState>(File.ReadAllText(_path)) ?? throw new InvalidDataException("Empty ratings state")
            : new();
    }

    private void Change(Action<RatingState> change)
    {
        lock (_gate)
        {
            var copy = JsonSerializer.Deserialize<RatingState>(JsonSerializer.Serialize(_state))!;
            change(copy);
            var temp = _path + ".tmp";
            File.WriteAllText(temp, JsonSerializer.Serialize(copy));
            File.Move(temp, _path, true);
            _state = copy;
        }
    }

    public void Enqueue(RatingEntry entry) => Change(state =>
    {
        if (!state.Entries.Any(x => x.UserId == entry.UserId && x.KinopoiskId == entry.KinopoiskId))
            state.Entries.Add(entry);
    });

    public RatingEntry[] Queue(Guid user)
    {
        lock (_gate) return _state.Entries.Where(x => x.UserId == user &&
            x.Status is "pending" or "failed" && x.AvailableAt <= DateTimeOffset.UtcNow).Select(x => x with { }).ToArray();
    }

    public RatingEntry? Find(Guid user, Guid id)
    {
        lock (_gate) return _state.Entries.FirstOrDefault(x => x.UserId == user && x.Id == id) is { } entry ? entry with { } : null;
    }

    public void Update(Guid user, Guid id, Action<RatingEntry> update) => Change(state =>
    {
        var entry = state.Entries.Single(x => x.Id == id && x.UserId == user);
        update(entry);
    });

    public bool Connected(Guid user) { lock (_gate) return _state.Connections.ContainsKey(user); }
    public void Connect(Guid user, string cookie) => Change(s => s.Connections[user] = _protector.Protect(cookie));
    public void Disconnect(Guid user) => Change(s => s.Connections.Remove(user));
    public string Cookie(Guid user)
    {
        lock (_gate) return _state.Connections.TryGetValue(user, out var value)
            ? _protector.Unprotect(value) : throw new InvalidOperationException("Подключите аккаунт Кинопоиска.");
    }
}
