using System.Runtime.CompilerServices;
using System.Runtime.InteropServices;
using System.Runtime.Versioning;

namespace oXeio.Agent.Native;

/// <summary>
/// Minimal handling of COM pointers: calling directly through vtable slots.
///
/// <b>Why not a wrapper library:</b> the whole capture needs only nine methods in total.
/// Vortice.Windows would pull in a prerelease SharpGen.Runtime and System.Text.Json with it, in an
/// agent that has no dependencies today.
///
/// <b>Why not <c>[GeneratedComInterface]</c>:</b> it requires declaring <i>all</i> of an
/// interface's methods in order. <c>ID3D11DeviceContext</c> has over 100 methods and
/// <c>CopyResource</c> is number 47, so 47 dummy declarations would be needed just to reach one
/// method. Writing the slot number directly lets it be checked by eye against the header.
///
/// Careful: <b>a wrong slot number gets no complaint from the compiler and no exception at run
/// time.</b> Wrong arguments go to the wrong function's address and corrupt memory, with symptoms
/// appearing somewhere else entirely, on some other day. So every slot was counted and matched
/// against the headers in <c>Windows Kits\10\Include\10.0.26100.0</c>, and the header's name is
/// written next to each one.
/// </summary>
[SupportedOSPlatform("windows")]
internal static unsafe class ComCall
{
    internal const int S_OK = 0;
    internal const int S_FALSE = 1;
    internal const int E_NOINTERFACE = unchecked((int)0x80004002);

    /// <summary>The three IUnknown slots are at the start of every interface.</summary>
    internal const int SlotQueryInterface = 0;
    internal const int SlotAddRef = 1;
    internal const int SlotRelease = 2;

    /// <summary>The first interface-specific slot: right after IUnknown.</summary>
    internal const int SlotFirst = 3;

    [MethodImpl(MethodImplOptions.AggressiveInlining)]
    private static void** Vtbl(nint self) => *(void***)self;

    /// <summary>The function pointer for slot <paramref name="slot"/>.</summary>
    [MethodImpl(MethodImplOptions.AggressiveInlining)]
    internal static void* Method(nint self, int slot) => Vtbl(self)[slot];

    internal static int QueryInterface(nint self, in Guid iid, out nint result)
    {
        nint outPtr;
        int hr;

        fixed (Guid* pIid = &iid)
        {
            hr = ((delegate* unmanaged[Stdcall]<nint, Guid*, nint*, int>)
                Method(self, SlotQueryInterface))(self, pIid, &outPtr);
        }

        // Careful: on failure there is no guarantee what outPtr holds, so we zero it ourselves,
        // otherwise Release() would be called on a garbage address in the finally.
        result = hr >= 0 ? outPtr : 0;
        return hr;
    }

    /// <summary>
    /// Release and zero the handle. Safe to call twice: this is what <c>finally</c> needs, because
    /// it cannot be known in advance which line threw.
    /// </summary>
    internal static void Release(ref nint self)
    {
        if (self == 0) return;

        var p = self;
        self = 0; // zero first, Release after: even if Release throws it will not run twice
        ((delegate* unmanaged[Stdcall]<nint, uint>)Method(p, SlotRelease))(p);
    }

    /// <summary>An exception that is recognisable when an HRESULT fails.</summary>
    internal static void ThrowIfFailed(int hr, string what)
    {
        if (hr >= 0) return;

        throw new COMException($"{what} failed (HRESULT 0x{hr:X8})", hr);
    }
}
