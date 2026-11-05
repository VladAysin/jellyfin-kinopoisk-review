using System.Reflection;
using System.Runtime.Loader;
using System.Text;
using System.Text.RegularExpressions;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;

namespace Jellyfin.Plugin.KinopoiskRatings;

/// <summary>Registers a response transformation; never writes jellyfin-web files.</summary>
public sealed class WebIntegration(IServiceProvider services, ILogger<WebIntegration> logger) : IHostedService
{
    public const string FilePattern = @"(?i)(^|[/\\])index\.html$";
    private static readonly Guid TransformationId = new("ff10e970-ff53-4bd8-b659-ed5bb04c6eb1");
    private object? _service;
    private MethodInfo? _remove;

    public Task StartAsync(CancellationToken cancellationToken)
    {
        try
        {
            var assembly = AssemblyLoadContext.All.SelectMany(x => x.Assemblies)
                .FirstOrDefault(x => x.GetName().Name == "Jellyfin.Plugin.FileTransformation");
            var type = assembly?.GetType("Jellyfin.Plugin.FileTransformation.Library.IWebFileTransformationWriteService");
            if (type is null) throw new InvalidOperationException("File Transformation is not loaded.");
            Register(type);
            logger.LogInformation("Kinopoisk Ratings web interface registered with File Transformation");
        }
        catch (Exception ex)
        {
            // A missing/incompatible optional UI dependency must not stop the media server.
            logger.LogError(ex, "Kinopoisk Ratings UI unavailable. Install File Transformation for Jellyfin 10.11.5 and restart the server.");
        }
        return Task.CompletedTask;
    }

    public void Register(Type serviceType)
    {
        // Resolve from the host's root provider, rather than the scoped provider retained
        // by older File Transformation PluginInterface versions. No compile-time plugin reference.
        var service = services.GetService(serviceType) ?? throw new InvalidOperationException("Transformation service is unavailable.");
        var add = serviceType.GetMethod("AddTransformation") ?? throw new MissingMethodException("AddTransformation");
        var callbackType = add.GetParameters()[2].ParameterType;
        var callback = Delegate.CreateDelegate(callbackType, typeof(WebIntegration).GetMethod(nameof(Transform))!);
        // Use the shared exact index.html pipeline so other plugins' transformations
        // compose with ours (File Transformation picks only one matching pipeline).
        add.Invoke(service, [TransformationId, "index.html", callback]);
        _service = service;
        _remove = serviceType.GetMethod("RemoveTransformation");
    }

    public Task StopAsync(CancellationToken cancellationToken)
    {
        try { _remove?.Invoke(_service, [TransformationId]); }
        catch (Exception ex) { logger.LogWarning(ex, "Could not unregister Kinopoisk Ratings web interface"); }
        _service = null;
        _remove = null;
        return Task.CompletedTask;
    }

    public static string Inject(string html)
    {
        // Also detects the manual loader from 0.1.0 so migrations cannot double-load it.
        if (html.Contains("KinopoiskRatings/client.js", StringComparison.OrdinalIgnoreCase)) return html;
        var body = Regex.Match(html, @"</body\s*>", RegexOptions.IgnoreCase);
        if (!body.Success) return html;
        return html.Insert(body.Index, "<script id=\"kinopoisk-ratings-loader\" defer src=\"../KinopoiskRatings/client.js?v=0.3.1\"></script>\n");
    }

    public static async Task Transform(string path, Stream contents)
    {
        if (!Regex.IsMatch(path, FilePattern)) return;
        contents.Position = 0;
        using var reader = new StreamReader(contents, Encoding.UTF8, true, 1024, leaveOpen: true);
        var original = await reader.ReadToEndAsync();
        var transformed = Inject(original);
        if (transformed == original) return;
        var bytes = Encoding.UTF8.GetBytes(transformed);
        contents.Position = 0;
        await contents.WriteAsync(bytes);
        contents.SetLength(contents.Position);
        contents.Position = 0;
    }
}
