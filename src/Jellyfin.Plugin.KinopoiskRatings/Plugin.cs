using MediaBrowser.Common.Configuration;
using MediaBrowser.Common.Plugins;
using MediaBrowser.Controller;
using MediaBrowser.Controller.Plugins;
using MediaBrowser.Model.Plugins;
using MediaBrowser.Model.Serialization;
using Microsoft.Extensions.DependencyInjection;

namespace Jellyfin.Plugin.KinopoiskRatings;

public sealed class Plugin(IApplicationPaths paths, IXmlSerializer serializer)
    : BasePlugin<BasePluginConfiguration>(paths, serializer), IHasWebPages
{
    public override string Name => "Kinopoisk Ratings";
    public override string Description => "Оценка просмотренного в Кинопоиске";
    public override Guid Id => new("ff10e970-ff53-4bd8-b659-ed5bb04c6eb1");

    public IEnumerable<PluginPageInfo> GetPages()
    {
        yield return new PluginPageInfo
        {
            Name = "KinopoiskRatings",
            EmbeddedResourcePath = "KinopoiskRatings.config.html"
        };
        yield return new PluginPageInfo
        {
            Name = "KinopoiskRatingsConfig.js",
            EmbeddedResourcePath = "KinopoiskRatings.config.js"
        };
    }
}

public sealed class ServiceRegistrator : IPluginServiceRegistrator
{
    public void RegisterServices(IServiceCollection services, IServerApplicationHost applicationHost)
    {
        services.AddSingleton<RatingStore>();
        services.AddSingleton<KinopoiskClient>();
        services.AddSingleton<RatingService>();
        services.AddHostedService<PlaybackMonitor>();
        services.AddHostedService<WebIntegration>();
    }
}
