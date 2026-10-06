import { HttpException } from '@nestjs/common';
import { RolloutStage } from '@prisma/client';

import type { PublishVersionDto } from './devices.dto';
import type { AgentVersionsService } from './agent-versions.service';

/**
 * Publishing an agent version from the server's command line
 * (`src/scripts/publish-agent-version.ts`) — for whoever already runs the
 * server, without the owner's dashboard session. Same checks as the
 * dashboard (it calls the same `AgentVersionsService`), plus: the sha256 is
 * required, and the audit log names the command line, not a person.
 *
 * Kept apart from the script so it can be tested: the script only wires
 * argv, the database and the exit code.
 */

/** The dashboard's rollout choices, by the names this command takes */
export const STAGES: Record<string, RolloutStage> = {
  canary: RolloutStage.canary, // "A few PCs first"
  partial: RolloutStage.partial, // "About half"
  all: RolloutStage.all, // "Everyone"
  halted: RolloutStage.halted, // "Stopped"
};

export const CLI_ACTOR = { via: 'system:cli' } as const;

export const USAGE = `Usage:
  node dist/scripts/publish-agent-version.js --version 0.5.1 --msi updates/oXeioAgent-0.5.1.msi --sha256 <64 hex> [--stage canary|partial|all|halted] [--notes "..."] [--dry-run]

  --msi     path under the storage root (what the dashboard calls "Path on the server")
  --sha256  required: the hash of the file you copied; refused if it differs
  --stage   who is offered it first (default canary = "A few PCs first"; all = "Everyone")
  --dry-run every check, nothing written`;

export interface PublishArgs {
  dto: PublishVersionDto;
  dryRun: boolean;
}

/** argv → what to publish, or a message for the person typing */
export function parsePublishArgs(argv: readonly string[]): PublishArgs | { error: string } {
  const value = (name: string): string | undefined => {
    const i = argv.indexOf(`--${name}`);
    const next = i >= 0 ? argv[i + 1] : undefined;
    return next !== undefined && !next.startsWith('--') ? next : undefined;
  };

  const version = value('version');
  const msiPath = value('msi');
  const sha256 = value('sha256');
  const stageName = value('stage') ?? 'canary';
  const notes = value('notes');

  if (!version || !/^\d+\.\d+\.\d+$/.test(version)) return { error: 'Give --version, e.g. 0.5.1' };
  if (!msiPath) return { error: 'Give --msi, the path under the storage root (e.g. updates/oXeioAgent-0.5.1.msi)' };
  if (!sha256 || !/^[0-9a-fA-F]{64}$/.test(sha256)) {
    return { error: 'Give --sha256: the 64-hex hash of the file you copied (sha256sum)' };
  }
  const stage = STAGES[stageName];
  if (!stage) return { error: `Unknown --stage "${stageName}" — one of: ${Object.keys(STAGES).join(', ')}` };

  return {
    dto: {
      version,
      msiPath,
      sha256: sha256.toLowerCase(),
      rolloutStage: stage,
      ...(notes ? { releaseNotes: notes.slice(0, 2000) } : {}),
    },
    dryRun: argv.includes('--dry-run'),
  };
}

/**
 * Runs it and returns the exit code: 0 published (or a clean dry run),
 * 2 bad arguments, 3 refused by a check (the reason is printed), 1 anything else.
 */
export async function runPublish(
  service: Pick<AgentVersionsService, 'publish' | 'preview'>,
  argv: readonly string[],
  out: (line: string) => void,
): Promise<number> {
  const parsed = parsePublishArgs(argv);
  if ('error' in parsed) {
    out(parsed.error);
    out(USAGE);
    return 2;
  }

  try {
    if (parsed.dryRun) {
      const plan = await service.preview(parsed.dto);
      out(
        `dry run — would publish ${plan.version} · ${plan.rolloutStage} · ${plan.sizeBytes} bytes · ` +
          `sha256 ${plan.sha256} · ${plan.signed ? 'signed' : 'unsigned'}` +
          (plan.autoPilotDeviceId !== null ? ` · pilot device #${plan.autoPilotDeviceId}` : ''),
      );
      return 0;
    }

    const row = await service.publish(CLI_ACTOR, parsed.dto, null);
    out(
      `published ${row.version} · ${row.rolloutStage} · ${row.sizeBytes} bytes · sha256 ${row.sha256}` +
        (row.pilotLabel ? ` · pilot ${row.pilotLabel}` : ''),
    );
    return 0;
  } catch (err) {
    if (err instanceof HttpException) {
      const body = err.getResponse();
      const message = typeof body === 'object' && body && 'message' in body ? (body as { message: unknown }).message : body;
      out(`refused: ${Array.isArray(message) ? message.join('; ') : String(message)}`);
      return 3;
    }
    out(`failed: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
}
