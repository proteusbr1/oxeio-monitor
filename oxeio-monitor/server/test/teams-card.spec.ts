import { describe, expect, it } from 'vitest';

import { teamsCard, trimForTeams } from '../src/alerts/teams.card';

/**
 * **The shape of the payload sent to Teams.**
 *
 * The one reason this file is needed: <b>Teams returns 200 even for a wrong
 * shape</b>, and nothing shows in the channel. So the failure is completely
 * silent — the server log says "sent", yet nobody ever received anything.
 *
 * This cannot be caught at the HTTP level, so the shape is pinned here.
 */
describe('teamsCard', () => {
  const card = teamsCard('oXeio — সাপ্তাহিক', 'Belal: 38h · Ali: 41h');

  /**
   * All three names must be spelled exactly like this. If any is changed,
   * Teams silently drops the attachment.
   */
  it('the envelope names are exact', () => {
    expect(card.type).toBe('message');
    expect(card.attachments[0].contentType).toBe(
      'application/vnd.microsoft.card.adaptive',
    );
    expect(card.attachments[0].content.type).toBe('AdaptiveCard');
  });

  /** Without `contentUrl` some clients drop the attachment */
  it('contentUrl is present, as null', () => {
    expect(card.attachments[0]).toHaveProperty('contentUrl', null);
  });

  /**
   * Version 1.4 — asking for anything newer would show the card **blank** on
   * some clients, another silent failure.
   */
  it('Adaptive Card version 1.4', () => {
    expect(card.attachments[0].content.version).toBe('1.4');
  });

  it('both the title and the text are in the card', () => {
    const body = card.attachments[0].content.body as { text: string }[];

    expect(body[0].text).toBe('oXeio — সাপ্তাহিক');
    expect(body[1].text).toContain('Belal: 38h');
  });

  /** Without `wrap`, long lines would be cut off and a name would show half */
  it('wrap is on in both blocks', () => {
    const body = card.attachments[0].content.body as { wrap: boolean }[];

    expect(body[0].wrap).toBe(true);
    expect(body[1].wrap).toBe(true);
  });

  it('can be converted to JSON', () => {
    expect(() => JSON.stringify(card)).not.toThrow();
  });
});

describe('trimForTeams', () => {
  it('short text is left intact', () => {
    expect(trimForTeams('ছোট')).toBe('ছোট');
  });

  /**
   * If it exceeds Teams' limit, Teams drops <b>the whole message</b>, not half.
   * So we trim it ourselves — otherwise the weekly summary would suddenly stop
   * arriving, silently, the day the team grows.
   */
  it('very long text is trimmed', () => {
    const trimmed = trimForTeams('ক'.repeat(30_000));

    expect(trimmed.length).toBeLessThanOrEqual(20_000);
  });

  /** Say in the message itself that it was trimmed — otherwise people would think the figures are just low */
  it('when trimmed, that is stated', () => {
    const trimmed = trimForTeams('ক'.repeat(30_000));

    expect(trimmed).toContain('has been trimmed');
  });

  it('it is not trimmed exactly at the limit', () => {
    const exact = 'ক'.repeat(20_000);

    expect(trimForTeams(exact)).toBe(exact);
  });
});
