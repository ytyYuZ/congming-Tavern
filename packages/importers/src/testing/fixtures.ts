/**
 * A small but COMPLETE library for the import/export tests: one world with a
 * worldbook entry, two characters, a prompt preset, a session with a three-message
 * tree, one checkpoint (the state `docs/04` §6 derives `state.json` from), one
 * agenda entry and two memories.
 *
 * WHY A SHARED FIXTURE: `§12-8` (empty database → everything restored) and the
 * round-trip test must exercise the SAME content, or "it round-trips" and "it
 * restores" would be claims about two different libraries. Every row here is
 * parsed through its own schema before it is seeded, so a fixture that drifts from
 * the frozen contracts fails loudly instead of producing a "valid" package the
 * real reader would reject.
 *
 * Every id is a literal so a test expectation can be hand-checked, and every
 * timestamp is fixed so two exports of the same library are byte-identical.
 */

import { COLLECTIONS, type CollectionName, type RowBase } from '@smarttavern/core';
import {
  type AgendaEntry,
  AgendaEntrySchema,
  type Character,
  type CharacterData,
  CharacterDataSchema,
  type CharacterVersion,
  CharacterVersionSchema,
  type Checkpoint,
  CheckpointSchema,
  type MemoryEntry,
  MemoryEntrySchema,
  type Message,
  MessageSchema,
  type PromptPreset,
  PromptPresetSchema,
  type Session,
  SessionSchema,
  type UuidV7,
  type World,
  type WorldbookEntry,
  WorldbookEntrySchema,
  type WorldData,
  WorldDataSchema,
  type WorldVersion,
  WorldVersionSchema,
} from '@smarttavern/schema';

/**
 * The minimal write surface the fixtures need. `MemoryStorageAdapter` implements
 * it (and so does the CLI's file-backed library), so a caller can seed a library
 * without this module depending on any particular storage implementation.
 */
export interface SeedTarget {
  seed<TRow extends RowBase>(name: CollectionName, rows: readonly TRow[]): void;
}

/** Fixed ids so expectations are literals a person can check by eye. */
export const FIXTURE = {
  worldId: '0192f0a1-1111-7000-8000-000000000001',
  worldVersionId: '0192f0a1-1111-7000-8000-000000000002',
  playerId: '0192f0a1-2222-7000-8000-000000000001',
  playerVersionId: '0192f0a1-2222-7000-8000-000000000002',
  npcId: '0192f0a1-2222-7000-8000-000000000003',
  npcVersionId: '0192f0a1-2222-7000-8000-000000000004',
  presetId: '0192f0a1-3333-7000-8000-000000000001',
  sessionId: '0192f0a1-4444-7000-8000-000000000001',
  messages: ['m-1', 'm-2', 'm-3'] as const,
  checkpointId: 'cp-1',
  agendaId: 'agenda-1',
  memoryIds: ['memory-1', 'memory-2'] as const,
  worldbookId: 'wb-1',
  base: 1_760_000_000_000,
} as const;

/* ─────────────────────────────── the world ───────────────────────────────── */

export function worldData(overrides: { name?: string; premise?: string } = {}): WorldData {
  return WorldDataSchema.parse({
    name: overrides.name ?? 'Silverpine',
    premise: overrides.premise ?? 'A lighthouse that should have gone dark.',
    genre: ['fantasy', 'mystery'],
    era: 'Age of Sail',
    techOrMagic: 'Tide-bound magic, low and local',
    regions: [{ id: 'silverpine', name: 'Silverpine', description: 'A harbour town' }],
    factions: [
      {
        id: 'night-watch',
        name: 'Night Watch',
        description: 'Keeps the lamps',
        goals: ['Keep the light'],
      },
    ],
    rulesOfNature: {
      powerSource: 'The tide',
      limits: 'Only between dusk and dawn',
      taboos: 'Never speak the deep name',
    },
    narrative: {
      conflict: 'The lamp is dying',
      tone: 'quiet dread',
      themes: ['duty'],
      style: 'terse',
    },
    calendar: {
      id: 'frostdial',
      name: 'Frostdial',
      minutesPerHour: 60,
      hoursPerDay: 24,
      months: [{ name: 'Frostmoon', days: 30 }],
      segments: [{ id: 'dusk', name: 'Dusk', fromHour: 18, toHour: 24 }],
    },
    startMinute: 1000,
    timeRhythm: { implicitAdvance: false, advanceEveryTurns: 4, stepMinutes: 10 },
    openingHooks: ['A bell rings twice'],
    customFields: {},
  });
}

export function worldVersion(
  overrides: { worldId?: UuidV7; version?: number; name?: string; premise?: string } = {},
): WorldVersion {
  return WorldVersionSchema.parse({
    id: FIXTURE.worldVersionId,
    worldId: overrides.worldId ?? FIXTURE.worldId,
    version: overrides.version ?? 1,
    createdAt: FIXTURE.base,
    updatedAt: FIXTURE.base,
    data: worldData({
      ...(overrides.name === undefined ? {} : { name: overrides.name }),
      ...(overrides.premise === undefined ? {} : { premise: overrides.premise }),
    }),
  });
}

/** The head row `docs/02` §7 keeps beside the immutable versions. */
export function worldHead(version: WorldVersion): World {
  return {
    id: version.worldId,
    name: version.data.name,
    headVersion: version.version,
    tags: [...version.data.genre],
    createdAt: version.createdAt,
    updatedAt: version.updatedAt,
  };
}

export function worldbookEntry(
  overrides: { worldId?: UuidV7; id?: string; content?: string } = {},
): WorldbookEntry {
  return WorldbookEntrySchema.parse({
    id: overrides.id ?? FIXTURE.worldbookId,
    worldId: overrides.worldId ?? FIXTURE.worldId,
    keywords: ['lamp'],
    content: overrides.content ?? 'The lamp burns whale oil.',
    priority: 10,
    position: 'pre_history',
    depth: 0,
    probability: 100,
    conditions: {},
    enabled: true,
  });
}

/* ───────────────────────────── the characters ────────────────────────────── */

export function characterData(
  overrides: { name?: string; description?: string } = {},
): CharacterData {
  return CharacterDataSchema.parse({
    name: overrides.name ?? 'Alice',
    description: overrides.description ?? 'The lamplighter.',
    personality: 'Dutiful',
    scenario: 'The lamp room',
    first_mes: 'The wick is low.',
    mes_example: '',
    creator_notes: '',
    system_prompt: '',
    post_history_instructions: '',
    alternate_greetings: [],
    tags: ['crew'],
    creator: 'fixture',
    character_version: '1',
    voice: { desire: 50, ability: 50, roles: ['lead'], maxLinesPerRound: 2, cooldown: 0 },
    visual: {
      appearance: { hair: 'black', eyes: 'grey', build: 'wiry', skin: 'weathered', marks: [] },
      outfits: [{ id: 'default', name: 'Default', prompt: 'oilskin coat' }],
      expressions: [{ id: 'neutral', label: 'Neutral', prompt: 'calm' }],
      style: { preset: 'l1', positive: '', negative: '', aspect: '832x1216' },
      params: { seedPolicy: 'fixed', seed: 7 },
    },
  });
}

export function characterVersion(
  overrides: {
    characterId?: UuidV7;
    id?: UuidV7;
    version?: number;
    name?: string;
    description?: string;
  } = {},
): CharacterVersion {
  return CharacterVersionSchema.parse({
    id: overrides.id ?? FIXTURE.playerVersionId,
    characterId: overrides.characterId ?? FIXTURE.playerId,
    version: overrides.version ?? 1,
    createdAt: FIXTURE.base,
    updatedAt: FIXTURE.base,
    data: characterData({
      ...(overrides.name === undefined ? {} : { name: overrides.name }),
      ...(overrides.description === undefined ? {} : { description: overrides.description }),
    }),
  });
}

export function characterHead(version: CharacterVersion): Character {
  return {
    id: version.characterId,
    name: version.data.name,
    headVersion: version.version,
    tags: [...version.data.tags],
    createdAt: version.createdAt,
    updatedAt: version.updatedAt,
  };
}

/* ─────────────────────────────── the session ─────────────────────────────── */

export function promptPreset(): PromptPreset {
  return PromptPresetSchema.parse({
    id: FIXTURE.presetId,
    name: 'Default preset',
    version: 1,
    blocks: [],
    createdAt: FIXTURE.base,
    updatedAt: FIXTURE.base,
  });
}

/** Which world/characters a session pins — lets a fixture build a conflicting save. */
export interface SessionOverrides {
  readonly id?: string;
  readonly title?: string;
  readonly world?: { id: UuidV7; version: number };
  readonly player?: { id: UuidV7; version: number };
  readonly cast?: readonly { id: UuidV7; version: number }[];
  readonly preset?: { id: UuidV7; version: number };
}

export function session(overrides: SessionOverrides = {}): Session {
  return SessionSchema.parse({
    id: overrides.id ?? FIXTURE.sessionId,
    title: overrides.title ?? 'Night in Silverpine',
    refs: {
      world: overrides.world ?? { id: FIXTURE.worldId, version: 1 },
      playerCharacter: overrides.player ?? { id: FIXTURE.playerId, version: 1 },
      cast: [...(overrides.cast ?? [{ id: FIXTURE.npcId, version: 1 }])],
      promptPreset: overrides.preset ?? { id: FIXTURE.presetId, version: 1 },
      modelConfig: { provider: 'mock', model: 'mock-1', params: { temperature: 0.8, topP: 0.9 } },
    },
    initialClock: 1000,
    // The LIVE state (ADR-032). Deliberately NOT the checkpoint below (`clock` 1120):
    // a package whose live state has moved past its last save point is the normal
    // case, and it is what makes `state.json` distinguishable from
    // `checkpoints.json` in a round-trip test.
    state: {
      scene: { title: 'The lamp room', location: 'Lighthouse', time: 1140 },
      clock: 1140,
      vars: { wind: 'strong' },
      sheets: {},
      deadlines: [],
    },
    schedulerMode: 'rules',
    headMessageId: FIXTURE.messages[2],
    createdAt: FIXTURE.base + 100,
    updatedAt: FIXTURE.base + 900,
  });
}

export function messages(sessionId: string = FIXTURE.sessionId): Message[] {
  const [first, second, third] = FIXTURE.messages;
  return [
    MessageSchema.parse({
      id: first,
      sessionId,
      parentId: null,
      role: 'system',
      kind: 'narration',
      content: 'The lamp room, dusk.',
      meta: { emittedAtMinute: 1000 },
      createdAt: FIXTURE.base + 200,
    }),
    MessageSchema.parse({
      id: second,
      sessionId,
      parentId: first,
      role: 'assistant',
      speakerId: FIXTURE.playerId,
      kind: 'dialogue',
      content: 'The wick is low.',
      meta: { emittedAtMinute: 1010 },
      createdAt: FIXTURE.base + 300,
    }),
    MessageSchema.parse({
      id: third,
      sessionId,
      parentId: second,
      role: 'assistant',
      speakerId: FIXTURE.npcId,
      kind: 'narration',
      content: 'Outside, the wind turns.',
      meta: { emittedAtMinute: 1015 },
      createdAt: FIXTURE.base + 400,
    }),
  ];
}

export function checkpoint(sessionId: string = FIXTURE.sessionId): Checkpoint {
  return CheckpointSchema.parse({
    id: FIXTURE.checkpointId,
    sessionId,
    label: 'Opening',
    messageId: FIXTURE.messages[2],
    auto: true,
    state: {
      scene: { title: 'The lamp room', location: 'Lighthouse', time: 1120 },
      clock: 1120,
      vars: { wind: 'strong' },
      sheets: {},
      deadlines: [
        { id: 'dl-1', label: 'Dawn', dueMinute: 1400, kind: 'countdown', status: 'active' },
      ],
    },
    agendaStatus: [],
    summary: 'The lamp was lit and then the wind rose.',
    castState: { [FIXTURE.playerId]: { present: true } },
    createdAt: FIXTURE.base + 500,
  });
}

export function agendaEntry(sessionId: string = FIXTURE.sessionId): AgendaEntry {
  return AgendaEntrySchema.parse({
    id: FIXTURE.agendaId,
    sessionId,
    title: 'The lamp gutters',
    description: 'A beat of quiet before the storm.',
    atMinute: 1120,
    actors: [FIXTURE.playerId],
    secret: false,
    status: 'pending',
    source: 'user',
  });
}

export function memories(
  sessionId: string = FIXTURE.sessionId,
  playerId: UuidV7 = FIXTURE.playerId,
): MemoryEntry[] {
  return [
    MemoryEntrySchema.parse({
      id: FIXTURE.memoryIds[0],
      scope: 'session',
      targetId: sessionId,
      text: 'The wind turned while the lamp burned.',
      keywords: ['wind', 'lamp'],
      importance: 40,
      atMinute: 1120,
      status: 'confirmed',
      sourceMessageId: FIXTURE.messages[2],
      createdAt: FIXTURE.base + 600,
    }),
    MemoryEntrySchema.parse({
      id: FIXTURE.memoryIds[1],
      scope: 'character',
      targetId: playerId,
      text: 'Alice never leaves the wick untrimmed.',
      keywords: ['alice'],
      importance: 30,
      atMinute: 1010,
      status: 'proposed',
      createdAt: FIXTURE.base + 610,
    }),
  ];
}

/** Which world/characters a session pins — lets a fixture build a conflicting save. */
export interface SessionPins extends SessionOverrides {
  readonly sessionId?: string;
}

export function sessionResource(pins: SessionPins = {}): {
  readonly session: Session;
  readonly messages: Message[];
  readonly checkpoints: Checkpoint[];
  readonly agenda: AgendaEntry[];
  readonly memories: MemoryEntry[];
} {
  const sessionId = pins.sessionId ?? FIXTURE.sessionId;
  const playerId = pins.player?.id ?? FIXTURE.playerId;
  return {
    session: session({
      id: sessionId,
      ...(pins.title === undefined ? {} : { title: pins.title }),
      ...(pins.world === undefined ? {} : { world: pins.world }),
      ...(pins.player === undefined ? {} : { player: pins.player }),
      ...(pins.cast === undefined ? {} : { cast: pins.cast }),
      ...(pins.preset === undefined ? {} : { preset: pins.preset }),
    }),
    messages: messages(sessionId),
    checkpoints: [checkpoint(sessionId)],
    agenda: [agendaEntry(sessionId)],
    memories: memories(sessionId, playerId),
  };
}

/* ─────────────────────────────── seeding ─────────────────────────────────── */

export interface SeedOverrides {
  readonly worldId?: UuidV7;
  readonly worldName?: string;
  readonly worldPremise?: string;
  readonly worldVersion?: number;
  readonly playerId?: UuidV7;
  readonly npcId?: UuidV7;
  readonly playerName?: string;
  readonly playerDescription?: string;
  /** Seed only the catalog (world + characters + preset), not a playthrough. */
  readonly includeSession?: boolean;
}

export interface SeededLibrary {
  readonly worldId: UuidV7;
  readonly worldVersionId: UuidV7;
  readonly playerId: UuidV7;
  readonly npcId: UuidV7;
  readonly presetId: UuidV7;
  readonly sessionId: string;
}

/**
 * Seed one complete library. `overrides` exist for the CONFLICT tests: a local
 * library that already holds a world or a character of the same name (or the same
 * id) with different content is what `docs/04` §12 items 10 and 12 are about.
 */
export function seedLibrary(storage: SeedTarget, overrides: SeedOverrides = {}): SeededLibrary {
  const worldId = overrides.worldId ?? FIXTURE.worldId;
  const world = worldVersion({
    worldId,
    ...(overrides.worldName === undefined ? {} : { name: overrides.worldName }),
    ...(overrides.worldPremise === undefined ? {} : { premise: overrides.worldPremise }),
    ...(overrides.worldVersion === undefined ? {} : { version: overrides.worldVersion }),
  });
  const player = characterVersion({
    characterId: overrides.playerId ?? FIXTURE.playerId,
    id: FIXTURE.playerVersionId,
    ...(overrides.playerName === undefined ? {} : { name: overrides.playerName }),
    ...(overrides.playerDescription === undefined
      ? {}
      : { description: overrides.playerDescription }),
  });
  const npc = characterVersion({
    characterId: overrides.npcId ?? FIXTURE.npcId,
    id: FIXTURE.npcVersionId,
    name: 'Bram',
    description: 'The harbourmaster.',
  });

  storage.seed(COLLECTIONS.worlds, [worldHead(world)]);
  storage.seed(COLLECTIONS.worldVersions, [world]);
  storage.seed(COLLECTIONS.worldbookEntries, [worldbookEntry({ worldId })]);
  storage.seed(COLLECTIONS.characters, [characterHead(player), characterHead(npc)]);
  storage.seed(COLLECTIONS.characterVersions, [player, npc]);
  storage.seed(COLLECTIONS.promptPresets, [promptPreset()]);

  if (overrides.includeSession !== false) {
    const resources = sessionResource({
      world: { id: worldId, version: world.version },
      player: { id: player.characterId, version: player.version },
      cast: [{ id: npc.characterId, version: npc.version }],
    });
    storage.seed(COLLECTIONS.sessions, [resources.session]);
    storage.seed(COLLECTIONS.messages, resources.messages);
    storage.seed(COLLECTIONS.checkpoints, resources.checkpoints);
    storage.seed(COLLECTIONS.agenda, resources.agenda);
    storage.seed(COLLECTIONS.memories, resources.memories);
  }

  return {
    worldId,
    worldVersionId: world.id,
    playerId: player.characterId,
    npcId: npc.characterId,
    presetId: FIXTURE.presetId,
    sessionId: FIXTURE.sessionId,
  };
}
