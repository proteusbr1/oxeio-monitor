import 'reflect-metadata';

import { BadRequestException, ValidationPipe } from '@nestjs/common';
import { describe, expect, it } from 'vitest';

import {
  HEARTBEAT_MAX_GUI_OBJECTS,
  HEARTBEAT_MAX_HANDLES,
  HEARTBEAT_MAX_MODULES,
  HEARTBEAT_MAX_PRIVATE_BYTES,
} from '../src/agent/agent.constants';
import { HeartbeatDto } from '../src/agent/dto';
import {
  RESOURCE_CEILING_HANDLES,
  RESOURCE_CEILING_PRIVATE_BYTES,
  describeResources,
  isOverCeiling,
  readResources,
  toResources,
} from '../src/agent/resources.rules';

/**
 * **The heartbeat's resource fields** (handles, private memory, GDI/USER
 * objects, injected DLLs).
 *
 * Careful: the pipe here is built with **the same options as `app.setup.ts`**
 * (`whitelist` + `forbidNonWhitelisted`). That is the whole point: under
 * `forbidNonWhitelisted` an unknown field 400s the **whole heartbeat**, and a
 * 400 on the heartbeat drops its commands too (revoke among them). So what
 * must be proven is both directions: the new fields pass, and a malformed one
 * is refused rather than silently stored.
 */
const pipe = new ValidationPipe({
  transform: true,
  whitelist: true,
  forbidNonWhitelisted: true,
});

const check = (body: Record<string, unknown>): Promise<HeartbeatDto> =>
  pipe.transform(body, { type: 'body', metatype: HeartbeatDto }) as Promise<HeartbeatDto>;

const base = { state: 'active', activeSecToday: 120 };

describe('HeartbeatDto — resource fields', () => {
  it('an older agent sends none of them: still accepted', async () => {
    await expect(check(base)).resolves.toBeInstanceOf(HeartbeatDto);
  });

  it('a full report is accepted as sent', async () => {
    const dto = await check({
      ...base,
      handleCount: 217_431,
      privateBytes: 7_516_192_768,
      gdiObjects: 312,
      userObjects: 95,
      injectedModules: ['nvspcap64.dll'],
    });

    expect(dto.handleCount).toBe(217_431);
    expect(dto.privateBytes).toBe(7_516_192_768);
    expect(dto.gdiObjects).toBe(312);
    expect(dto.userObjects).toBe(95);
    expect(dto.injectedModules).toEqual(['nvspcap64.dll']);
  });

  /**
   * Careful: the leaking agent is the one whose report matters most. The
   * bounds are Windows' own hard limits, far above the ceiling, so the very
   * heartbeat that carries the bad news is never the one refused.
   */
  it('values far above the ceiling (a leak in progress) are still accepted', async () => {
    await expect(
      check({
        ...base,
        handleCount: HEARTBEAT_MAX_HANDLES,
        privateBytes: HEARTBEAT_MAX_PRIVATE_BYTES,
        gdiObjects: HEARTBEAT_MAX_GUI_OBJECTS,
        userObjects: HEARTBEAT_MAX_GUI_OBJECTS,
      }),
    ).resolves.toBeInstanceOf(HeartbeatDto);
    expect(HEARTBEAT_MAX_HANDLES).toBeGreaterThan(RESOURCE_CEILING_HANDLES * 100);
    expect(HEARTBEAT_MAX_PRIVATE_BYTES).toBeGreaterThan(RESOURCE_CEILING_PRIVATE_BYTES * 100);
    expect(Number.isSafeInteger(HEARTBEAT_MAX_PRIVATE_BYTES)).toBe(true);
  });

  it('an empty module list is accepted', async () => {
    await expect(check({ ...base, injectedModules: [] })).resolves.toBeInstanceOf(
      HeartbeatDto,
    );
  });

  it.each([
    ['negative handles', { handleCount: -1 }],
    ['fractional handles', { handleCount: 1.5 }],
    ['handles as a string', { handleCount: '20000' }],
    ['handles past the Windows limit', { handleCount: HEARTBEAT_MAX_HANDLES + 1 }],
    ['private bytes past the address space', { privateBytes: HEARTBEAT_MAX_PRIVATE_BYTES + 1 }],
    ['GDI objects past the quota', { gdiObjects: HEARTBEAT_MAX_GUI_OBJECTS + 1 }],
    ['USER objects negative', { userObjects: -5 }],
    ['modules not a list', { injectedModules: 'nvspcap64.dll' }],
    ['a module that is not a string', { injectedModules: [42] }],
    ['a module given as a path', { injectedModules: ['C:\\Users\\sumaiya\\x.dll'] }],
    ['a module with a space', { injectedModules: ['nv sp.dll'] }],
    ['a module name too long', { injectedModules: [`${'a'.repeat(61)}.dll`] }],
    [
      'too many modules',
      { injectedModules: Array.from({ length: HEARTBEAT_MAX_MODULES + 1 }, (_, i) => `m${i}.dll`) },
    ],
  ])('%s → 400', async (_, extra) => {
    await expect(check({ ...base, ...extra })).rejects.toBeInstanceOf(BadRequestException);
  });

  /** The guard that makes all of the above matter: an unknown field 400s. */
  it('an unknown field is still refused (forbidNonWhitelisted)', async () => {
    await expect(check({ ...base, handles: 5 })).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe('toResources', () => {
  it('nothing sent → null, so the last real report is kept', () => {
    expect(toResources({})).toBeNull();
  });

  it('a partial report fills the gaps with null', () => {
    expect(toResources({ handleCount: 900 })).toEqual({
      handleCount: 900,
      privateBytes: null,
      gdiObjects: null,
      userObjects: null,
      injectedModules: [],
    });
  });

  it('module names are lower-cased and de-duplicated: one DLL, one entry', () => {
    expect(
      toResources({ injectedModules: ['NvSpCap64.dll', 'nvspcap64.dll'] })?.injectedModules,
    ).toEqual(['nvspcap64.dll']);
  });
});

describe('readResources', () => {
  it.each([null, undefined, 'x', 3, ['a']])('garbage (%s) is null, not an error', (raw) => {
    expect(readResources(raw)).toBeNull();
  });

  it('reads back what toResources wrote', () => {
    const r = toResources({ handleCount: 5, privateBytes: 10, injectedModules: ['a.dll'] });
    expect(readResources(JSON.parse(JSON.stringify(r)))).toEqual(r);
  });
});

describe('isOverCeiling', () => {
  const r = (handleCount: number | null, privateBytes: number | null) => ({
    handleCount,
    privateBytes,
    gdiObjects: null,
    userObjects: null,
    injectedModules: [],
  });

  it('at the ceiling is not over; one past it is', () => {
    expect(isOverCeiling(r(RESOURCE_CEILING_HANDLES, 0))).toBe(false);
    expect(isOverCeiling(r(RESOURCE_CEILING_HANDLES + 1, 0))).toBe(true);
    expect(isOverCeiling(r(0, RESOURCE_CEILING_PRIVATE_BYTES))).toBe(false);
    expect(isOverCeiling(r(0, RESOURCE_CEILING_PRIVATE_BYTES + 1))).toBe(true);
  });

  it('unknown numbers are not over: no alert on a guess', () => {
    expect(isOverCeiling(r(null, null))).toBe(false);
    expect(isOverCeiling(null)).toBe(false);
  });

  it('a loaded DLL alone is not over the ceiling', () => {
    expect(isOverCeiling({ ...r(800, 90_000_000), injectedModules: ['nvspcap64.dll'] })).toBe(
      false,
    );
  });
});

describe('describeResources', () => {
  it('one line with what matters', () => {
    expect(
      describeResources({
        handleCount: 217_431,
        privateBytes: 7_516_192_768,
        gdiObjects: 300,
        userObjects: 90,
        injectedModules: ['nvspcap64.dll'],
      }),
    ).toBe('217,431 handles · 7.5 GB private memory · nvspcap64.dll loaded');
  });
});
