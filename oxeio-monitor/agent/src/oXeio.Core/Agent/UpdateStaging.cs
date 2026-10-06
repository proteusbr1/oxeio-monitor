namespace oXeio.Core.Agent;

/// <summary>
/// H04: the state a downloaded update is in.
///
/// <b>The agent never runs the MSI on its own.</b> It only downloads, checks the hash, and
/// leaves it marked "ready".
///
/// The reason is this repo's own experience
/// ([G58](../../../../docs/08-Gap-Analysis.md)): an MSI shipped with a wrong LaunchCondition,
/// and then it turned out that <b>a new MSI could not fix it</b>: in a major upgrade the old
/// package is removed using its own cached MSI, bug included. That one machine had to be
/// fixed by hand. If that happened automatically on 15 PCs at 3 a.m., the whole office's
/// tracking would be down in the morning and 15 visits by hand would be needed.
///
/// So the split is deliberate: <b>download and verification are automatic, installation is
/// in a person's hands.</b> The server's staged rollout (canary → partial → all) decides which
/// machine gets the offer when; the owner watches the dashboard and decides.
/// </summary>
public enum UpdateStage
{
    /// <summary>Nothing new.</summary>
    None,

    /// <summary>The server has made an offer; not downloaded yet.</summary>
    Offered,

    /// <summary>Downloaded, but the hash has not been checked yet.</summary>
    Downloaded,

    /// <summary>The hash matched: ready to install.</summary>
    Verified,

    /// <summary>
    /// Downloaded but the hash did not match: the file was deleted.
    /// Not something to suppress quietly: either the transfer was damaged or someone changed
    /// the file midway. If the second is true, it is an attack.
    /// </summary>
    Corrupt,
}

/// <summary>The current picture of the update: the tray and diagnostics both show it.</summary>
public sealed record UpdateStatus
{
    public static readonly UpdateStatus Idle = new() { Stage = UpdateStage.None };

    public required UpdateStage Stage { get; init; }

    public string? Version { get; init; }

    /// <summary>Exactly where the MSI is on disk once verified.</summary>
    public string? MsiPath { get; init; }

    public bool Mandatory { get; init; }

    /// <summary>What went wrong, if it failed.</summary>
    public string? Detail { get; init; }

    /// <summary>One line suitable to show staff.</summary>
    public string Describe() => Stage switch
    {
        UpdateStage.None => "Running the latest version",
        UpdateStage.Offered => $"New version {Version} — downloading",
        UpdateStage.Downloaded => $"New version {Version} — verifying",
        UpdateStage.Verified => $"New version {Version} is ready to install",

        // Saying "there was a problem" would lead nobody to act; this says what to do.
        UpdateStage.Corrupt => $"Version {Version} downloaded but the file did not match — tell IT",

        _ => "Unknown",
    };
}
