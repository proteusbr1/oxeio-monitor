using System.Runtime.Versioning;

namespace oXeio.Agent.Platform.Capture;

/// <summary>The raw image of one monitor: BGRA, top-down.</summary>
[SupportedOSPlatform("windows")]
internal sealed class CapturedFrame(
    byte[] pixels, int width, int height, int stride, MonitorInfo monitor, string engine)
{
    public byte[] Pixels { get; } = pixels;
    public int Width { get; } = width;
    public int Height { get; } = height;
    public int Stride { get; } = stride;
    public MonitorInfo Monitor { get; } = monitor;

    /// <summary>
    /// Which engine took this image.
    ///
    /// It is kept with each image, not with the engine object, because with the fallback one
    /// monitor can be captured by DXGI and another by GDI in the same slot. In GDI images
    /// hardware-accelerated video comes out black, so the answer to "why is this image black" needs
    /// to travel with the image.
    /// </summary>
    public string Engine { get; } = engine;

    /// <summary>
    /// The OS itself reported that DRM-protected content was excluded. Only the DXGI path can know
    /// this; GDI has no equivalent.
    /// </summary>
    public bool ProtectedContentMasked { get; init; }
}

[SupportedOSPlatform("windows")]
internal interface IScreenCapturer : IDisposable
{
    string Name { get; }

    /// <summary>On failure null, not an exception, because even if one monitor fails the others
    /// should still be taken.</summary>
    CapturedFrame? Capture(MonitorInfo monitor);

    /// <summary>
    /// Whether the last <c>null</c> was because of the engine's inability.
    ///
    /// The default is <c>true</c>: an engine that does not keep this distinction has its failures
    /// counted as failures. Only one that really has a valid state of "nothing to give this time"
    /// overrides it.
    /// </summary>
    bool LastFailureWasEngineFault => true;
}
