using System.Runtime.InteropServices;
using System.Runtime.Versioning;

using oXeio.Agent.Native;
using oXeio.Core.Watchdog;

namespace oXeio.Agent.Platform;

/// <summary>
/// <b>What this process holds right now</b>: handles, private memory, GDI/USER objects, and which
/// known-troublesome DLLs have been injected into it.
///
/// Why it exists: <c>nvspcap64.dll</c> (NVIDIA's ShadowPlay/Instant Replay hook, injected into any
/// process that uses Desktop Duplication) leaked ~217,000 handles and 7 GB of private memory in one
/// agent over twelve days. Nothing measured it, so all anyone saw was "that PC got slow". The
/// numbers go to the server in the heartbeat and into <see cref="ResourceCeiling"/>, which decides
/// whether to restart.
///
/// Careful: every number comes from a direct syscall on the pseudo-handle, never from
/// <see cref="System.Diagnostics.Process"/>: its properties take a snapshot of every process on the
/// machine per call (see <see cref="Kernel32.GetProcessHandleCount"/>), which is the wrong tool for
/// something that runs once a minute for weeks.
///
/// Careful: no exception leaves this class. A failed probe is <c>null</c>, and <c>null</c> means
/// "unknown", which the ceiling treats as "do nothing". A probe that threw would take the heartbeat
/// loop's iteration with it, and that loop also delivers revoke.
/// </summary>
[SupportedOSPlatform("windows")]
internal static class ResourceProbe
{
    public static ResourceSample? Read()
    {
        try
        {
            var self = Kernel32.GetCurrentProcess();

            if (!Kernel32.GetProcessHandleCount(self, out var handles)) return null;

            var memory = new PROCESS_MEMORY_COUNTERS_EX
            {
                cb = (uint)Marshal.SizeOf<PROCESS_MEMORY_COUNTERS_EX>(),
            };
            if (!Kernel32.GetProcessMemoryInfo(self, out memory, memory.cb)) return null;

            return new ResourceSample
            {
                HandleCount = handles,
                PrivateBytes = (long)Math.Min((ulong)memory.PrivateUsage, (ulong)long.MaxValue),

                // Careful: 0 is also the failure value of GetGuiResources. That is acceptable for
                // telemetry: "0 GDI objects" cannot hide a leak, which is the only thing these are
                // read for.
                GdiObjects = (int)Math.Min(User32.GetGuiResources(self, User32.GR_GDIOBJECTS), int.MaxValue),
                UserObjects = (int)Math.Min(User32.GetGuiResources(self, User32.GR_USEROBJECTS), int.MaxValue),

                InjectedModules = LoadedWatchedModules(),
            };
        }
        catch (Exception ex) when (ex is DllNotFoundException or EntryPointNotFoundException or ExternalException)
        {
            return null;
        }
    }

    /// <summary>Which of <see cref="ResourceCeiling.WatchedModules"/> are loaded, in list order.</summary>
    private static IReadOnlyList<string> LoadedWatchedModules()
    {
        List<string>? found = null;

        foreach (var name in ResourceCeiling.WatchedModules)
        {
            if (Kernel32.GetModuleHandle(name) != 0) (found ??= []).Add(name);
        }

        return found ?? (IReadOnlyList<string>)[];
    }
}
