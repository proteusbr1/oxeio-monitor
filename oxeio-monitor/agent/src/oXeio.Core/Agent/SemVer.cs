using System.Text.RegularExpressions;

namespace oXeio.Core.Agent;

/// <summary>
/// The agent's version numbers: what the server may offer, and whether an offer is an
/// upgrade.
///
/// Careful: <b>the offer's version is not just a label.</b> It is put into a file name
/// (<c>updates\oXeioAgent-{version}.msi</c>) and into the download URL. Before this check it was
/// used exactly as the server sent it, so a version like <c>..\..\x</c> (a compromised server, or
/// anyone in the middle on a plain-HTTP LAN) would write the MSI outside the updates folder.
/// Only a strict SemVer string can get near a path.
///
/// The accepted shape is the server's own (<c>PublishVersionDto</c> in
/// <c>server/src/devices/devices.dto.ts</c>): <c>^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$</c>. Careful: the
/// pre-release part allows <c>-</c> there, so it is allowed here too; anything stricter would make
/// a version the owner could legally publish never install. None of these characters can form a
/// path separator or a <c>..</c> segment on its own (a dot only appears inside the pre-release part,
/// after a <c>-</c>), and the file name is still checked separately against the folder.
/// </summary>
public static partial class SemVer
{
    /// <summary>
    /// Careful: the numbers are limited to 9 digits so they always fit an <c>int</c>; an
    /// overflowing "99999999999.0.0" must be refused, not wrap around and compare as something
    /// small. The total length is capped too: it ends up in a file name.
    /// </summary>
    [GeneratedRegex(@"^(\d{1,9})\.(\d{1,9})\.(\d{1,9})(?:-([0-9A-Za-z.-]+))?$", RegexOptions.CultureInvariant)]
    private static partial Regex Shape();

    public const int MaxLength = 64;

    /// <summary>
    /// <c>true</c> for <c>1.2.3</c> and <c>1.2.3-beta.1</c>; <c>false</c> for <c>v1.2.3</c>,
    /// <c>1.2</c>, build metadata (<c>+abc</c>), whitespace, path characters, or anything longer
    /// than <see cref="MaxLength"/>.
    /// </summary>
    public static bool IsValid(string? version) => TryParse(version, out _);

    /// <summary>The parsed pieces of a valid version.</summary>
    public readonly record struct Parts(int Major, int Minor, int Patch, string? PreRelease);

    public static bool TryParse(string? version, out Parts parts)
    {
        parts = default;
        if (version is null || version.Length > MaxLength) return false;

        var m = Shape().Match(version);
        if (!m.Success) return false;

        parts = new Parts(
            int.Parse(m.Groups[1].Value, System.Globalization.CultureInfo.InvariantCulture),
            int.Parse(m.Groups[2].Value, System.Globalization.CultureInfo.InvariantCulture),
            int.Parse(m.Groups[3].Value, System.Globalization.CultureInfo.InvariantCulture),
            m.Groups[4].Success ? m.Groups[4].Value : null);
        return true;
    }

    /// <summary>
    /// SemVer 2.0 precedence: numbers part by part (so <c>1.10.0</c> &gt; <c>1.9.0</c>, which a
    /// string comparison gets backwards), then a release beats any pre-release of the same number
    /// (<c>1.0.0</c> &gt; <c>1.0.0-beta</c>), then pre-release identifiers one by one (numeric ones
    /// numerically, and below alphanumeric ones).
    /// </summary>
    public static int Compare(Parts a, Parts b)
    {
        var c = a.Major.CompareTo(b.Major);
        if (c != 0) return c;
        c = a.Minor.CompareTo(b.Minor);
        if (c != 0) return c;
        c = a.Patch.CompareTo(b.Patch);
        if (c != 0) return c;

        if (a.PreRelease is null) return b.PreRelease is null ? 0 : 1;
        if (b.PreRelease is null) return -1;

        var x = a.PreRelease.Split('.');
        var y = b.PreRelease.Split('.');

        for (var i = 0; i < Math.Min(x.Length, y.Length); i++)
        {
            var xNum = IsNumeric(x[i]);
            var yNum = IsNumeric(y[i]);

            if (xNum && yNum)
            {
                // compared as digit strings, so even a 30-digit identifier cannot overflow
                var xs = x[i].TrimStart('0');
                var ys = y[i].TrimStart('0');
                c = xs.Length != ys.Length
                    ? xs.Length.CompareTo(ys.Length)
                    : string.CompareOrdinal(xs, ys);
            }
            else if (xNum != yNum)
            {
                c = xNum ? -1 : 1;
            }
            else
            {
                c = string.CompareOrdinal(x[i], y[i]);
            }

            if (c != 0) return Math.Sign(c);
        }

        return x.Length.CompareTo(y.Length);
    }

    private static bool IsNumeric(string s) => s.Length > 0 && s.All(char.IsAsciiDigit);

    /// <summary>
    /// <b>L2:</b> is <paramref name="offered"/> strictly newer than <paramref name="running"/>?
    ///
    /// Careful: <b>the same version or an older one is refused.</b> The server never offers one
    /// (<c>isNewer</c> in <c>rollout.ts</c>), so an offer like that means a replayed or forged
    /// offer: an old, properly signed MSI with a known bug sent again would pass both the hash and
    /// the owner's signature (the signature covers only the MSI's hash, not its version), and
    /// "installing" it would be a downgrade. The MSI's own MajorUpgrade rule would also block it,
    /// but only after the staff member has already clicked through UAC.
    ///
    /// Careful: an invalid <paramref name="offered"/> is never newer. An invalid
    /// <paramref name="running"/> (this would be a build problem: the version comes from the
    /// assembly, see <c>Program.TrimBuildMetadata</c>) is treated as <c>0.0.0</c>, so a PC with a
    /// broken version string can still be repaired by an update instead of being stuck forever.
    ///
    /// Careful: the server's <c>isNewer</c> splits on dots only, so it reads
    /// <c>1.0.0-beta.2</c> as <c>1.0.0.2</c> (newer than <c>1.0.0</c>); here SemVer says it is
    /// older. Pre-release builds are not published to the fleet today; if they ever are, such an
    /// offer is refused here (safe direction) and logged each time it comes.
    /// </summary>
    public static bool IsNewer(string? offered, string? running)
    {
        if (!TryParse(offered, out var o)) return false;
        if (!TryParse(running, out var r)) r = new Parts(0, 0, 0, null);
        return Compare(o, r) > 0;
    }
}
