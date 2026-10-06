using System.Globalization;

using oXeio.Core.Time;

namespace oXeio.Agent.Ui;

/// <summary>
/// Number and time formats shown in the tray. All on-screen text is English, digits are ASCII.
///
/// Important: the csproj sets <c>InvariantGlobalization=true</c>, so <c>new CultureInfo(...)</c>
/// silently becomes invariant without any exception. We therefore depend on no culture and
/// pass <see cref="CultureInfo.InvariantCulture"/> explicitly to every <c>ToString</c>.
/// Whatever the machine's locale, staff and the dashboard see exactly the same numbers.
/// </summary>
internal static class UiText
{
    private static readonly string[] Months =
    [
        "January", "February", "March", "April", "May", "June",
        "July", "August", "September", "October", "November", "December",
    ];

    public static string Number(int value) =>
        value.ToString(CultureInfo.InvariantCulture);

    /// <summary>
    /// Target hours: no decimal for a whole number, otherwise one decimal place.
    ///
    /// Writing "208.0 hours" would suggest the decimal matters, yet the target is almost
    /// always a round number. A half-hour target (207.5) must not be hidden either, hence the
    /// two forms.
    /// </summary>
    public static string Hours(double hours)
    {
        if (double.IsNaN(hours) || double.IsInfinity(hours)) return "0";

        return Math.Abs(hours - Math.Round(hours)) < 0.05
            ? Number((int)Math.Round(hours))
            : hours.ToString("0.#", CultureInfo.InvariantCulture);
    }

    /// <summary>Hours:minutes, e.g. <c>127:30</c>.</summary>
    public static string Duration(TimeSpan span)
    {
        // Showing negative time makes no sense; if a bad calculation arrives, show zero
        if (span < TimeSpan.Zero) span = TimeSpan.Zero;

        // Use <c>span.TotalHours</c>, not <c>span.Hours</c>. Hours wraps to zero at 24, so
        // 127 hours in a month would show as "7:30": the number the whole system exists for
        // would be wrong while looking completely believable.
        var hours = (int)span.TotalHours;
        var minutes = span.Minutes;

        return hours.ToString(CultureInfo.InvariantCulture) + ":" +
               minutes.ToString("00", CultureInfo.InvariantCulture);
    }

    /// <summary>
    /// Hours:minutes:<b>seconds</b>, e.g. <c>2:27:14</c>.
    ///
    /// The owner asked for the "today's total" hero number to show seconds. Only in that one
    /// place: in the target-comparison bars (<c>2:27 / 8:00</c>) seconds are just noise, so
    /// those use <see cref="Duration"/>.
    /// </summary>
    public static string DurationLong(TimeSpan span)
    {
        if (span < TimeSpan.Zero) span = TimeSpan.Zero;

        // TotalHours as in Duration(); span.Hours wraps to zero at 24
        var hours = (int)span.TotalHours;

        return hours.ToString(CultureInfo.InvariantCulture) + ":" +
               span.Minutes.ToString("00", CultureInfo.InvariantCulture) + ":" +
               span.Seconds.ToString("00", CultureInfo.InvariantCulture);
    }

    /// <summary>
    /// <c>3:59:22</c> → <c>("3:59", ":22")</c>. Splits off the seconds part of the hero
    /// number so it can be drawn at <b>half size</b> (<see cref="TrayFontRole.HeroSeconds"/>).
    ///
    /// The rule lives here, not in the drawing code: it is a <b>decision</b> ("where do the
    /// seconds start"), not layout, and so it is testable.
    ///
    /// Important: the <b>last</b> colon is searched for, not the first. Taking the first colon
    /// in <c>3:59:22</c> would shrink all of <c>:59:22</c>, minutes included.
    ///
    /// With fewer than two colons (e.g. <c>3:59</c>) there are no seconds, so the tail is
    /// empty and the whole figure is drawn at hero size. Nothing calls this path today, but if
    /// <see cref="Duration"/> ever ends up in the hero it is better to render correctly than
    /// to break silently.
    /// </summary>
    public static (string Head, string Tail) SplitSeconds(string figure)
    {
        if (string.IsNullOrEmpty(figure)) return (figure ?? string.Empty, string.Empty);

        var last = figure.LastIndexOf(':');
        var first = figure.IndexOf(':');

        // `last == first` means there is only one colon: that is hours:minutes, not seconds
        if (last <= 0 || last == first) return (figure, string.Empty);

        return (figure[..last], figure[last..]);
    }

    /// <summary>0.61 → <c>61%</c>. Not clamped above 1 (ADR: extra work must not be invisible).</summary>
    public static string Percent(double ratio)
    {
        if (double.IsNaN(ratio) || double.IsInfinity(ratio)) ratio = 0;

        var pct = (int)Math.Round(ratio * 100, MidpointRounding.AwayFromZero);
        if (pct < 0) pct = 0;
        if (pct > 9999) pct = 9999;

        return Number(pct) + "%";
    }

    /// <summary>
    /// <c>HH:MM</c> on the Dhaka clock.
    ///
    /// Not <c>ToLocalTime()</c>. The machine's time zone may be set wrongly (often the case on
    /// a new PC), and then the "last sync" staff saw would not match the server's records,
    /// while the number looked perfectly fine.
    /// </summary>
    public static string Clock(DateTimeOffset instant)
    {
        var local = WorkTime.LocalTimeOf(instant);
        return local.Hour.ToString("00", CultureInfo.InvariantCulture) + ":" +
               local.Minute.ToString("00", CultureInfo.InvariantCulture);
    }

    /// <summary>The Dhaka date, e.g. <c>9 August 2026</c>.</summary>
    public static string WorkDate(DateTimeOffset instant)
    {
        var date = WorkTime.WorkDateOf(instant);
        var month = Months[date.Month - 1];
        return $"{Number(date.Day)} {month} {Number(date.Year)}";
    }

    /// <summary>
    /// Truncates to at most <paramref name="max"/> UTF-16 units.
    ///
    /// A plain <c>Substring</c> is not allowed. Although the text is English, symbols such as
    /// the check mark or warning sign appear here, and staff names can contain any character.
    /// Cutting in the middle of a surrogate pair leaves half a code point, which the renderer
    /// draws as garbage. So cuts happen at text element (grapheme) boundaries.
    /// </summary>
    public static string Truncate(string text, int max)
    {
        if (max <= 0) return string.Empty;
        if (string.IsNullOrEmpty(text) || text.Length <= max) return text;

        // A '…' goes at the end, so reserve room for it up front
        var budget = max - 1;
        var kept = 0;

        var walker = StringInfo.GetTextElementEnumerator(text);
        while (walker.MoveNext())
        {
            var element = walker.GetTextElement();
            if (kept + element.Length > budget) break;
            kept += element.Length;
        }

        return kept <= 0 ? "…" : string.Concat(text.AsSpan(0, kept), "…");
    }
}
