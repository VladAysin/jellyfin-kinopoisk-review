using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Entities.Movies;
using MediaBrowser.Controller.Entities.TV;
using MediaBrowser.Controller.Library;
using MediaBrowser.Controller.Session;
using Jellyfin.Data.Enums;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;

namespace Jellyfin.Plugin.KinopoiskRatings;

public sealed class PlaybackMonitor(ISessionManager sessions, ILibraryManager library,
    IUserDataManager userData, RatingStore store, ILogger<PlaybackMonitor> logger) : IHostedService
{
    public Task StartAsync(CancellationToken cancellationToken)
    {
        sessions.PlaybackStopped += Stopped;
        return Task.CompletedTask;
    }

    public Task StopAsync(CancellationToken cancellationToken)
    {
        sessions.PlaybackStopped -= Stopped;
        return Task.CompletedTask;
    }

    private void Stopped(object? sender, PlaybackStopEventArgs e)
    {
        if (!e.PlayedToCompletion || e.Item is not (Movie or Episode)) return;
        try
        {
            foreach (var user in e.Users)
            {
                BaseItem target = e.Item;
                if (e.Item is Episode episode)
                {
                    // Completed all available, non-virtual regular episodes in this season.
                    // This intentionally makes no claim about episodes absent from the library.
                    if (episode.ParentIndexNumber is null or <= 0 || episode.Series is null) continue;
                    var siblings = library.GetItemList(new InternalItemsQuery
                    {
                        ParentId = episode.ParentId,
                        IncludeItemTypes = [BaseItemKind.Episode],
                        IsVirtualItem = false
                    });
                    if (siblings.Any(x => x.Id != episode.Id && userData.GetUserData(user, x)?.Played != true)) continue;
                    target = episode.Series;
                }

                var kp = target.ProviderIds.FirstOrDefault(x => x.Key.Equals("kinopoisk", StringComparison.OrdinalIgnoreCase)).Value;
                if (!long.TryParse(kp, out var id) || id <= 0) continue;
                store.Enqueue(new RatingEntry
                {
                    UserId = user.Id, ItemId = target.Id, Title = target.Name,
                    KinopoiskId = id.ToString(System.Globalization.CultureInfo.InvariantCulture),
                    Kind = target is Series ? "series" : "movie"
                });
            }
        }
        catch (Exception ex) { logger.LogError(ex, "Could not queue Kinopoisk rating after playback"); }
    }
}
