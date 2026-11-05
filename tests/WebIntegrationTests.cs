using System.Text;
using System.Reflection;
using System.Runtime.Loader;
using Jellyfin.Plugin.KinopoiskRatings;
using Microsoft.Extensions.Logging.Abstractions;

public static class WebIntegrationTests
{
    public static async Task RunAsync()
    {
        var service = new FakeTransformService();
        var integration = new WebIntegration(new SingleProvider(service), NullLogger<WebIntegration>.Instance);
        integration.Register(typeof(IFakeTransformService));
        if (service.Callback == null) throw new Exception("Callback not registered");
        using var stream = new MemoryStream();
        await stream.WriteAsync(Encoding.UTF8.GetBytes("<html><body>Привет</BODY></html>"));
        await service.Callback("/web/index.html", stream);
        var html = Encoding.UTF8.GetString(stream.ToArray());
        if (!html.Contains("Привет") || !html.Contains("../KinopoiskRatings/client.js?v=0.2.0")) throw new Exception("Injection failed");
        await service.Callback("/web/index.html", stream);
        if (Encoding.UTF8.GetString(stream.ToArray()) != html) throw new Exception("Duplicate injection");
        if (WebIntegration.Inject("no body") != "no body") throw new Exception("Invalid HTML changed");
        var manual = "<body><script src='../KinopoiskRatings/client.js'></script></body>";
        if (WebIntegration.Inject(manual) != manual) throw new Exception("Legacy loader duplicated");
        if (new Uri(new Uri("https://server/jellyfin/web/index.html"), "../KinopoiskRatings/client.js").AbsolutePath != "/jellyfin/KinopoiskRatings/client.js") throw new Exception("Base URL broken");
        await integration.StopAsync(default);
        if (service.Callback != null) throw new Exception("Callback not removed");
        Console.WriteLine("Web transformation registration and injection tests passed.");
        var dependency = Environment.GetEnvironmentVariable("FILE_TRANSFORMATION_TEST_DLL");
        if (!string.IsNullOrEmpty(dependency)) await CheckRealDependency(dependency);
    }

    private static async Task CheckRealDependency(string path)
    {
        var assembly = AssemblyLoadContext.Default.LoadFromAssemblyPath(Path.GetFullPath(path));
        var serviceType = assembly.GetType("Jellyfin.Plugin.FileTransformation.Infrastructure.WebFileTransformationService", true)!;
        var loggerType = assembly.GetType("Jellyfin.Plugin.FileTransformation.Library.IFileTransformationLogger", true)!;
        var logger = DispatchProxy.Create(loggerType, typeof(NoopLogger));
        var service = Activator.CreateInstance(serviceType, logger)!;
        var integration = new WebIntegration(new SingleProvider(service), NullLogger<WebIntegration>.Instance);
        await integration.StartAsync(default);
        if (!(bool)serviceType.GetMethod("NeedsTransformation")!.Invoke(service, ["index.html"])!) throw new Exception("Real dependency registration failed");
        using var stream = new MemoryStream();
        await stream.WriteAsync(Encoding.UTF8.GetBytes("<body>real release</body>"));
        await (Task)serviceType.GetMethod("RunTransformation")!.Invoke(service, ["index.html", stream])!;
        if (!Encoding.UTF8.GetString(stream.ToArray()).Contains("KinopoiskRatings/client.js")) throw new Exception("Real dependency transform failed");
        await integration.StopAsync(default);
        Console.WriteLine("Published File Transformation DLL integration passed.");
    }

    public class NoopLogger : DispatchProxy
    {
        protected override object? Invoke(MethodInfo? method, object?[]? args) => method?.ReturnType == typeof(bool) ? false : null;
    }

    public delegate Task TransformFile(string path, Stream contents);
    public interface IFakeTransformService
    {
        void AddTransformation(Guid id, string pattern, TransformFile callback);
        void RemoveTransformation(Guid id);
    }
    private sealed class FakeTransformService : IFakeTransformService
    {
        public TransformFile? Callback;
        public void AddTransformation(Guid id, string pattern, TransformFile callback) => Callback = callback;
        public void RemoveTransformation(Guid id) => Callback = null;
    }
    private sealed class SingleProvider(object instance) : IServiceProvider
    {
        public object? GetService(Type serviceType) => serviceType.IsInstanceOfType(instance) ? instance : null;
    }
}
