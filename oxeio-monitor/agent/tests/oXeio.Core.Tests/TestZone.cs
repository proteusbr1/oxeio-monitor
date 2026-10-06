using System.Runtime.CompilerServices;

using oXeio.Core.Time;

namespace oXeio.Core.Tests;

/// <summary>
/// The work zone these tests run in: a fixed UTC+6 (<c>Etc/GMT-6</c>, no daylight saving and
/// no city). Every fixed instant in this project was written for it — "04:00Z" is 10 AM here —
/// so it is pinned once, when the assembly loads, whatever the product's default zone is.
/// </summary>
internal static class TestZone
{
    [ModuleInitializer]
    internal static void Pin() => WorkTime.UseDefaultForTests("Etc/GMT-6", 360);
}
