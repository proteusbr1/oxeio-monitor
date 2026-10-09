/** Address lists typed by hand: any of , ; or new line separates them */
export function parseAddressList(text: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of text.split(/[,;\n]/)) {
    const email = part.trim();
    if (!email || seen.has(email.toLowerCase())) continue;
    seen.add(email.toLowerCase());
    out.push(email);
  }
  return out;
}

export function formatAddressList(list: readonly string[]): string {
  return list.join('\n');
}

/**
 * What the Sender field starts with. The server fills in `oXeio <no-reply@host>`
 * when none was saved; showing that back would make the next save freeze it, so a
 * later change of server would keep the old host in the sender. Left empty instead.
 */
export function senderFieldValue(host: string, from: string): string {
  return from === `oXeio <no-reply@${host}>` ? '' : from;
}

/** English sentence keys, translated where shown */
export function testResultKey(
  outcome: 'sent' | 'not_configured' | 'failed',
): string {
  switch (outcome) {
    case 'sent':
      return '✓ Sent. Check the inbox (and the spam folder).';
    case 'not_configured':
      return 'Email is not set up yet — fill in the server above and save.';
    default:
      return 'The mail server refused or could not be reached:';
  }
}
