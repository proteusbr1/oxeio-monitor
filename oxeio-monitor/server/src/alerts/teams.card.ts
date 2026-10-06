/**
 * **Payload for sending to Teams.** Pure functions, no network.
 *
 * A separate file because the structure is the most fragile part here: if one
 * JSON field is wrong, Teams **returns 200 and shows nothing**, so the failure
 * is silent. Keeping it pure lets the structure be pinned down in tests.
 *
 * Which structure and why: Microsoft retired the old "Office 365 connector"
 * (MessageCard). The current route is **Workflows / Power Automate** with
 * "When a Teams webhook request is received", and that wants an
 * <b>Adaptive Card</b> wrapped in a specific envelope. So that envelope is
 * used here; old connector URLs usually accept it too.
 */

/** The outer envelope of a Teams card: all three names must be spelled exactly like this */
export interface TeamsPayload {
  type: 'message';
  attachments: {
    contentType: 'application/vnd.microsoft.card.adaptive';
    contentUrl: null;
    content: Record<string, unknown>;
  }[];
}

/**
 * Careful: Adaptive Card version **1.4**, not a newer one. Teams' desktop and
 * web clients do not render every version equally, and asking for something
 * too new would show the card **blank** for some people: a silent failure again.
 */
const CARD_VERSION = '1.4';

/**
 * Careful: Teams has a per-message size limit (~28 KB). The weekly summary is
 * far smaller for a 15-person office, but if the team grows it could hit the
 * limit one day, and then Teams would **drop the whole message**, not half of
 * it. So it is trimmed here, and the message itself says that it was trimmed.
 */
const MAX_CHARS = 20_000;
const TRIMMED_NOTE = '\n\n_(The message was too long and has been trimmed — the full text is in the server log)_';

export function trimForTeams(text: string): string {
  if (text.length <= MAX_CHARS) return text;
  return text.slice(0, MAX_CHARS - TRIMMED_NOTE.length) + TRIMMED_NOTE;
}

/**
 * Plain text -> Teams card.
 *
 * `wrap: true` and `TextBlock`, with no tables or columns. The summary is
 * plain text written for Telegram; forcing it into a card layout would make
 * the message's source differ in two places, and one day one would change and
 * the other would not.
 */
export function teamsCard(title: string, text: string): TeamsPayload {
  return {
    type: 'message',
    attachments: [
      {
        contentType: 'application/vnd.microsoft.card.adaptive',
        // Careful: `null` **must not be omitted**. Some clients silently drop
        // the attachment when the field is missing.
        contentUrl: null,
        content: {
          $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
          type: 'AdaptiveCard',
          version: CARD_VERSION,
          body: [
            {
              type: 'TextBlock',
              text: title,
              weight: 'Bolder',
              size: 'Medium',
              wrap: true,
            },
            {
              type: 'TextBlock',
              text: trimForTeams(text),
              wrap: true,
            },
          ],
        },
      },
    ],
  };
}
