using System.Text.Json;
using System.Text.Json.Serialization;

namespace oXeio.Agent.Sync;

/// <summary>
/// The JSON rules for talking to the server: a single <see cref="JsonSerializerOptions"/>
/// for the whole module.
///
/// <b>Why one instance only:</b> on first use <c>JsonSerializerOptions</c> builds a metadata
/// cache of the types inside itself and then becomes read-only. Creating a new one per call
/// would rebuild that cache every time; in a process that runs for a week that is a silent
/// CPU and memory cost, and nobody will sit down with a profiler to find it.
/// </summary>
internal static class SyncJson
{
    /// <summary>
    /// <b>Why camelCase is mandatory:</b> the server's DTOs are validated with class-validator
    /// and their properties are camelCase (<c>clientUuid</c>, <c>durationSec</c>).
    /// If PascalCase is sent, NestJS treats them as unknown fields, the required fields are
    /// "missing", and the whole batch gets a 400, which is
    /// <see cref="oXeio.Core.Agent.SyncOutcome.Permanent"/>, meaning 500 rows are deleted.
    /// One naming-policy mistake is that short a path to losing payroll data.
    ///
    /// <b>Why DateTimeOffset is not formatted by hand:</b> System.Text.Json writes ISO-8601
    /// round-trip with the offset by default (<c>2026-08-09T14:03:02.1234567+06:00</c>), which
    /// JS's <c>new Date(...)</c>, and therefore the server's
    /// <c>@Type(() =&gt; Date) @IsDate()</c>, accepts as is. A custom converter would lose the
    /// offset at exactly this point, work-zone local time would be taken as UTC, and everyone's
    /// hours would land off by the zone's offset (three hours in São Paulo), on the wrong day.
    ///
    /// Careful: without <see cref="JsonIgnoreCondition.WhenWritingNull"/>, a field like
    /// <c>appName: null</c> would go on the wire; when <c>@IsOptional()</c> gets null, some
    /// validators treat it as "present but the wrong type" and return a 400. Not sending it
    /// is the safe choice.
    /// </summary>
    internal static readonly JsonSerializerOptions Options = new(JsonSerializerDefaults.Web)
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,

        // Even if the server later returns something in PascalCase, it can still be read.
        PropertyNameCaseInsensitive = true,

        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,

        // Careful: some NestJS transformations return numbers as strings ("accepted": "12").
        // That is accepted when reading, not when writing.
        NumberHandling = JsonNumberHandling.AllowReadingFromString,

        // Unknown fields are silently dropped (the default), so an old agent does not break
        // when the server adds new fields.
        WriteIndented = false,
    };

    /// <summary>
    /// Never throws: bad JSON means <c>null</c>.
    ///
    /// Careful: the call site must decide what null means. After a 2xx, null means "the server
    /// accepted it but we could not read the reply", which is a success, not a failure.
    /// </summary>
    internal static T? TryDeserialize<T>(string? json) where T : class
    {
        if (string.IsNullOrWhiteSpace(json)) return null;

        try
        {
            return JsonSerializer.Deserialize<T>(json, Options);
        }
        catch (JsonException)
        {
            return null;
        }
        catch (NotSupportedException)
        {
            return null;
        }
    }

    internal static string Serialize<T>(T value) => JsonSerializer.Serialize(value, Options);
}
