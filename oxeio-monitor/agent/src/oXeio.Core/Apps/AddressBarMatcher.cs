namespace oXeio.Core.Apps;

/// <summary>
/// Which Edit control in a browser window is the address bar — the rule only,
/// no UI Automation, so it can be tested anywhere.
///
/// Order, most reliable first:
/// <list type="number">
/// <item>identifiers that do not depend on the UI language: Chromium's
/// omnibox class (Chrome, Edge, Brave, Opera, Vivaldi) and Firefox's
/// <c>urlbar-input</c>;</item>
/// <item>the accessible name, which is translated — English names, plus any
/// extra names the caller passes;</item>
/// <item>the first Edit, as before.</item>
/// </list>
///
/// ⚠️ Step 1 is the reason this exists. The names in step 2 are English only,
/// so on a Windows or browser in another language step 2 never matched and
/// every read fell through to step 3.
/// </summary>
public static class AddressBarMatcher
{
    /// <summary>UIA <c>ClassName</c> of the Chromium omnibox, in every UI language.</summary>
    public const string ChromiumOmniboxClass = "OmniboxViewViews";

    /// <summary>UIA <c>AutomationId</c> of the Firefox address bar, in every UI language.</summary>
    public const string FirefoxUrlBarId = "urlbar-input";

    /// <summary>
    /// What the address bar is called, per language/version. Careful: this list is
    /// incomplete and cannot ever be complete, which is why there is a name-independent
    /// fallback below.
    /// </summary>
    public static readonly IReadOnlyList<string> AddressBarNames =
    [
        "address and search bar", // Chrome
        "address bar",            // Edge (some versions)
        "search or enter address", // Firefox
        "omnibox",
    ];

    /// <summary>
    /// Index of the address bar among <paramref name="count"/> Edit controls,
    /// or <c>null</c> when there are none.
    ///
    /// ⚠️ The properties are asked for lazily, one control at a time, and the
    /// search stops at the first match. Each one is a cross-process UI
    /// Automation call and the whole read has 400 ms; reading every property
    /// of every Edit up front could time out on a page full of form fields,
    /// and enough timeouts switch the reader off for good.
    /// </summary>
    /// <param name="classNameOf">UIA <c>ClassName</c> of the i-th Edit</param>
    /// <param name="automationIdOf">UIA <c>AutomationId</c> of the i-th Edit</param>
    /// <param name="nameOf">UIA <c>Name</c> of the i-th Edit</param>
    /// <param name="extraNames">more accessible names to accept, beyond the English ones</param>
    public static int? Pick(
        int count,
        Func<int, string?> classNameOf,
        Func<int, string?> automationIdOf,
        Func<int, string?> nameOf,
        IReadOnlyCollection<string>? extraNames = null)
    {
        if (count <= 0) return null;

        for (var i = 0; i < count; i++)
        {
            if (string.Equals(classNameOf(i), ChromiumOmniboxClass, StringComparison.Ordinal) ||
                string.Equals(automationIdOf(i), FirefoxUrlBarId, StringComparison.Ordinal))
                return i;
        }

        for (var i = 0; i < count; i++)
        {
            var name = nameOf(i);
            if (string.IsNullOrEmpty(name)) continue;

            if (Matches(name, AddressBarNames)) return i;
            if (extraNames is not null && Matches(name, extraNames)) return i;
        }

        // This can also pick the wrong control (e.g. a search box inside the page). That does
        // no harm: DomainParser drops anything that does not look like a domain, so a typed
        // search term is never stored as a "domain".
        return 0;
    }

    private static bool Matches(string name, IEnumerable<string> known)
    {
        foreach (var k in known)
        {
            if (!string.IsNullOrWhiteSpace(k) && name.Contains(k, StringComparison.OrdinalIgnoreCase))
                return true;
        }

        return false;
    }
}
