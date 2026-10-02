/**
 * SillyTavern fixtures for the M1-I1 round-trip tests (`docs/06` §2.6).
 *
 * PROVENANCE — READ THIS BEFORE TRUSTING A NUMBER HERE
 * No real SillyTavern card or world info file was available in this checkout, so
 * these documents are SYNTHETIC: they are written to the shapes ST documents (V1
 * flat, V2/V3 `{spec, spec_version, data}`, world info `{entries: {uid: …}}`, the
 * V2 `character_book`), and every field name, position value and `extensions` key
 * comes from the published V2/V3 card spec and ST's own world-info fields — not
 * from a sample someone exported. A REAL sample should replace them as soon as one
 * can be obtained; the tests below are written so that swapping the literals is the
 * whole change, and `sillytavern/png.test.ts` asserts that each PNG's `chara`/`ccv3`
 * payload parses back to exactly the JSON literal beside it, so a replacement cannot
 * drift silently from the file it claims to be.
 *
 * HOW THE PNGs WERE MADE: Pillow encoded a 4×4 RGB image (IHDR/IDAT are its bytes,
 * and its CRC-32s are the real thing), and the `gAMA`/`tIME`/`tEXt` chunks — the
 * card chunk included — were appended with Python's `binascii.crc32`. So nothing in
 * this file was produced by the parser under test, which is the point: the tests
 * compare our CRC, base64 and chunk walk against an unrelated implementation.
 *
 * WHY THEY ARE TYPED `Record<string, unknown>`: these are other people's documents.
 * A fixture with a precise TS type would let a test read a field that the FORMAT
 * does not guarantee, and the imports exist to handle `unknown`.
 */

/** A V1 card: the flat legacy object TavernAI exported. */
export const ST_CARD_V1: Record<string, unknown> = {
  name: 'Old Lamplighter',
  description: 'A V1 card: six fields and a legacy creator comment.',
  personality: 'Terse',
  scenario: 'The lamp room',
  first_mes: 'The wick is low.',
  mes_example: '',
  creatorcomment: 'Legacy notes, from before the field was renamed.',
  avatar: 'none',
  talkativeness: '0.5',
  fav: false,
};

/** The V2 `data` object of the card fixture, on its own for readability. */
export const ST_CARD_V2_DATA: Record<string, unknown> = {
  name: 'Bram the Lamplighter',
  description: "Keeps the Silverpine light — and does not talk about the tide. Éowyn's cousin.",
  personality: 'Dutiful, terse, superstitious',
  scenario: 'The lamplight room at dusk',
  first_mes: 'The wick is low, and the wind is turning. 🕯',
  mes_example: '<START>\n{{user}}: Is the light dying?\n{{char}}: Everything dies, slowly.',
  creator_notes: 'A quiet card, kept for round-trip tests.',
  system_prompt: 'Stay in character; never speak for the player.',
  post_history_instructions: 'Keep replies under three paragraphs.',
  alternate_greetings: ['The door opens before you knock.', 'Rain, and the lamp already lit.'],
  tags: ['crew', 'lighthouse', 'fixture'],
  creator: 'fixture-author',
  character_version: '1.2',
  character_book: {
    name: 'Lamplighter lore',
    description: 'What the card knows about its own world.',
    scan_depth: 3,
    token_budget: 512,
    recursive_scanning: false,
    extensions: {
      fixture: 'character_book',
    },
    entries: [
      {
        id: 0,
        keys: ['lamp', 'wick'],
        secondary_keys: ['oil'],
        comment: 'The lamp',
        name: 'The lamp',
        content: 'The lamp burns whale oil, and the wick is trimmed at dusk.',
        constant: false,
        selective: true,
        insertion_order: 10,
        enabled: true,
        position: 'before_char',
        case_sensitive: false,
        extensions: {},
      },
      {
        id: 1,
        keys: ['tide'],
        secondary_keys: [],
        name: 'The tide',
        content: 'The tide comes at dusk and takes the low road.',
        constant: true,
        selective: false,
        insertion_order: 20,
        enabled: false,
        position: 'after_char',
        extensions: {
          fixture: 'entry',
        },
      },
    ],
  },
  extensions: {
    talkativeness: 0.6,
    depth_prompt: {
      depth: 4,
      prompt: 'Stay in character.',
    },
    smarttavern: {
      voice: {
        desire: 60,
        ability: 40,
        roles: ['lead'],
        maxLinesPerRound: 2,
        cooldown: 1,
      },
      visual: {
        appearance: {
          hair: 'grey',
          eyes: 'green',
          build: 'wiry',
          skin: 'weathered',
          marks: ['burn scar'],
        },
        outfits: [
          {
            id: 'default',
            name: 'Default',
            prompt: 'oilskin coat',
          },
        ],
        expressions: [
          {
            id: 'neutral',
            label: 'Neutral',
            prompt: 'calm',
          },
        ],
        style: {
          preset: 'l1',
          positive: '',
          negative: '',
          aspect: '832x1216',
        },
        params: {
          seedPolicy: 'fixed',
          seed: 7,
        },
      },
      sampling: {
        temperature: 0.9,
        topP: 0.95,
      },
      'a-future-member': {
        why: 'a build that did not exist yet wrote this',
      },
    },
  },
};

/** A V2 card as it appears in a `chara` chunk or a `.json` export. */
export const ST_CARD_V2: Record<string, unknown> = {
  spec: 'chara_card_v2',
  spec_version: '2.0',
  data: ST_CARD_V2_DATA,
};

/** The V3 `data` object of the same character, with the V3-only members. */
export const ST_CARD_V3_DATA: Record<string, unknown> = {
  name: 'Bram the Lamplighter',
  description: "Keeps the Silverpine light — and does not talk about the tide. Éowyn's cousin.",
  personality: 'Dutiful, terse, superstitious',
  scenario: 'The lamplight room at dusk',
  first_mes: 'The wick is low, and the wind is turning. 🕯',
  mes_example: '<START>\n{{user}}: Is the light dying?\n{{char}}: Everything dies, slowly.',
  creator_notes: 'A quiet card, kept for round-trip tests.',
  system_prompt: 'Stay in character; never speak for the player.',
  post_history_instructions: 'Keep replies under three paragraphs.',
  alternate_greetings: ['The door opens before you knock.', 'Rain, and the lamp already lit.'],
  tags: ['crew', 'lighthouse', 'fixture'],
  creator: 'fixture-author',
  character_version: '1.2',
  character_book: {
    name: 'Lamplighter lore',
    description: 'What the card knows about its own world.',
    scan_depth: 3,
    token_budget: 512,
    recursive_scanning: false,
    extensions: {
      fixture: 'character_book',
    },
    entries: [
      {
        id: 0,
        keys: ['lamp', 'wick'],
        secondary_keys: ['oil'],
        comment: 'The lamp',
        name: 'The lamp',
        content: 'The lamp burns whale oil, and the wick is trimmed at dusk.',
        constant: false,
        selective: true,
        insertion_order: 10,
        enabled: true,
        position: 'before_char',
        case_sensitive: false,
        extensions: {},
      },
      {
        id: 1,
        keys: ['tide'],
        secondary_keys: [],
        name: 'The tide',
        content: 'The tide comes at dusk and takes the low road.',
        constant: true,
        selective: false,
        insertion_order: 20,
        enabled: false,
        position: 'after_char',
        extensions: {
          fixture: 'entry',
        },
      },
    ],
  },
  extensions: {
    talkativeness: 0.6,
    depth_prompt: {
      depth: 4,
      prompt: 'Stay in character.',
    },
    smarttavern: {
      voice: {
        desire: 60,
        ability: 40,
        roles: ['lead'],
        maxLinesPerRound: 2,
        cooldown: 1,
      },
      visual: {
        appearance: {
          hair: 'grey',
          eyes: 'green',
          build: 'wiry',
          skin: 'weathered',
          marks: ['burn scar'],
        },
        outfits: [
          {
            id: 'default',
            name: 'Default',
            prompt: 'oilskin coat',
          },
        ],
        expressions: [
          {
            id: 'neutral',
            label: 'Neutral',
            prompt: 'calm',
          },
        ],
        style: {
          preset: 'l1',
          positive: '',
          negative: '',
          aspect: '832x1216',
        },
        params: {
          seedPolicy: 'fixed',
          seed: 7,
        },
      },
      sampling: {
        temperature: 0.9,
        topP: 0.95,
      },
      'a-future-member': {
        why: 'a build that did not exist yet wrote this',
      },
    },
  },
  nickname: 'Bram',
  creator_notes_multilingual: {
    fr: 'Une carte tranquille.',
  },
  source: ['https://example.invalid/bram'],
  group_only_greetings: ['The room is already full when you arrive.'],
  creation_date: 1760000000,
  modification_date: 1760000900,
  assets: [
    {
      type: 'icon',
      uri: 'ccdefault:',
      name: 'main',
      ext: 'png',
    },
  ],
};

/** A V3 card, the shape ST writes into a `ccv3` chunk. */
export const ST_CARD_V3: Record<string, unknown> = {
  spec: 'chara_card_v3',
  spec_version: '3.0',
  data: ST_CARD_V3_DATA,
};

/** The V2 card's `data.character_book`, in the V2 spec's spelling. */
export const ST_CHARACTER_BOOK: Record<string, unknown> = {
  name: 'Lamplighter lore',
  description: 'What the card knows about its own world.',
  scan_depth: 3,
  token_budget: 512,
  recursive_scanning: false,
  extensions: {
    fixture: 'character_book',
  },
  entries: [
    {
      id: 0,
      keys: ['lamp', 'wick'],
      secondary_keys: ['oil'],
      comment: 'The lamp',
      name: 'The lamp',
      content: 'The lamp burns whale oil, and the wick is trimmed at dusk.',
      constant: false,
      selective: true,
      insertion_order: 10,
      enabled: true,
      position: 'before_char',
      case_sensitive: false,
      extensions: {},
    },
    {
      id: 1,
      keys: ['tide'],
      secondary_keys: [],
      name: 'The tide',
      content: 'The tide comes at dusk and takes the low road.',
      constant: true,
      selective: false,
      insertion_order: 20,
      enabled: false,
      position: 'after_char',
      extensions: {
        fixture: 'entry',
      },
    },
  ],
};

/** A standalone world info file, keyed by `uid` as ST exports it. */
export const ST_WORLD_INFO: Record<string, unknown> = {
  entries: {
    '0': {
      uid: 0,
      key: ['lamp', 'wick'],
      keysecondary: ['oil'],
      comment: 'The lamp',
      content: 'The lamp burns whale oil.',
      constant: false,
      vectorized: false,
      selective: true,
      selectiveLogic: 0,
      addMemo: true,
      order: 10,
      position: 0,
      disable: false,
      excludeRecursion: false,
      preventRecursion: false,
      delayUntilRecursion: false,
      probability: 100,
      useProbability: true,
      depth: 4,
      group: '',
      groupOverride: false,
      groupWeight: 100,
      scanDepth: null,
      caseSensitive: null,
      matchWholeWords: null,
      useGroupScoring: null,
      automationId: '',
      role: null,
      sticky: 0,
      cooldown: 0,
      delay: 0,
      displayIndex: 0,
      extensions: {},
    },
    '1': {
      uid: 1,
      key: ['storm'],
      keysecondary: [],
      comment: 'The storm',
      content: 'The wind turns outside the harbour.',
      constant: true,
      selective: false,
      order: 20,
      position: 4,
      disable: true,
      probability: 40,
      useProbability: true,
      depth: 2,
      extensions: {},
    },
    '2': {
      uid: 2,
      key: 'single-key',
      keysecondary: [],
      comment: 'Odds and ends',
      content: 'Sometimes the lamp gutters for no reason.',
      constant: false,
      order: '30',
      position: 'before_char',
      disable: false,
      probability: 33.5,
      useProbability: false,
      depth: 1,
      extensions: {},
    },
  },
};

/** The same image without a card chunk: what PNG export embeds a card INTO. */
export const ST_BASE_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAIAAAAmkwkpAAAABGdBTUEAALGPC/xhBQAAAAd0SU1FB+oJGwoAAPyUpX0AAAAmdEVYdFNvZnR3YXJlAFNpbGx5VGF2ZXJuIGZpeHR1cmUgZ2VuZXJhdG9yHN98+gAAABNJREFUeJxjFJJQYIABJjgLLwcAD2oAUmk0bs8AAAAASUVORK5CYII=';

/** The base image plus a `chara` chunk holding `ST_CARD_V2` as base64 JSON. */
export const ST_CARD_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAIAAAAmkwkpAAAABGdBTUEAALGPC/xhBQAAAAd0SU1FB+oJGwoAAPyUpX0AAAAmdEVYdFNvZnR3YXJlAFNpbGx5VGF2ZXJuIGZpeHR1cmUgZ2VuZXJhdG9yHN98+gAAABNJREFUeJxjFJJQYIABJjgLLwcAD2oAUmk0bs8AAAumdEVYdGNoYXJhAGV5SnpjR1ZqSWpvaVkyaGhjbUZmWTJGeVpGOTJNaUlzSW5Od1pXTmZkbVZ5YzJsdmJpSTZJakl1TUNJc0ltUmhkR0VpT25zaWJtRnRaU0k2SWtKeVlXMGdkR2hsSUV4aGJYQnNhV2RvZEdWeUlpd2laR1Z6WTNKcGNIUnBiMjRpT2lKTFpXVndjeUIwYUdVZ1UybHNkbVZ5Y0dsdVpTQnNhV2RvZENEaWdKUWdZVzVrSUdSdlpYTWdibTkwSUhSaGJHc2dZV0p2ZFhRZ2RHaGxJSFJwWkdVdUlNT0piM2Q1YmlkeklHTnZkWE5wYmk0aUxDSndaWEp6YjI1aGJHbDBlU0k2SWtSMWRHbG1kV3dzSUhSbGNuTmxMQ0J6ZFhCbGNuTjBhWFJwYjNWeklpd2ljMk5sYm1GeWFXOGlPaUpVYUdVZ2JHRnRjR3hwWjJoMElISnZiMjBnWVhRZ1pIVnpheUlzSW1acGNuTjBYMjFsY3lJNklsUm9aU0IzYVdOcklHbHpJR3h2ZHl3Z1lXNWtJSFJvWlNCM2FXNWtJR2x6SUhSMWNtNXBibWN1SVBDZmxhOGlMQ0p0WlhOZlpYaGhiWEJzWlNJNklqeFRWRUZTVkQ1Y2JudDdkWE5sY24xOU9pQkpjeUIwYUdVZ2JHbG5hSFFnWkhscGJtYy9YRzU3ZTJOb1lYSjlmVG9nUlhabGNubDBhR2x1WnlCa2FXVnpMQ0J6Ykc5M2JIa3VJaXdpWTNKbFlYUnZjbDl1YjNSbGN5STZJa0VnY1hWcFpYUWdZMkZ5WkN3Z2EyVndkQ0JtYjNJZ2NtOTFibVF0ZEhKcGNDQjBaWE4wY3k0aUxDSnplWE4wWlcxZmNISnZiWEIwSWpvaVUzUmhlU0JwYmlCamFHRnlZV04wWlhJN0lHNWxkbVZ5SUhOd1pXRnJJR1p2Y2lCMGFHVWdjR3hoZVdWeUxpSXNJbkJ2YzNSZmFHbHpkRzl5ZVY5cGJuTjBjblZqZEdsdmJuTWlPaUpMWldWd0lISmxjR3hwWlhNZ2RXNWtaWElnZEdoeVpXVWdjR0Z5WVdkeVlYQm9jeTRpTENKaGJIUmxjbTVoZEdWZlozSmxaWFJwYm1keklqcGJJbFJvWlNCa2IyOXlJRzl3Wlc1eklHSmxabTl5WlNCNWIzVWdhMjV2WTJzdUlpd2lVbUZwYml3Z1lXNWtJSFJvWlNCc1lXMXdJR0ZzY21WaFpIa2diR2wwTGlKZExDSjBZV2R6SWpwYkltTnlaWGNpTENKc2FXZG9kR2h2ZFhObElpd2labWw0ZEhWeVpTSmRMQ0pqY21WaGRHOXlJam9pWm1sNGRIVnlaUzFoZFhSb2IzSWlMQ0pqYUdGeVlXTjBaWEpmZG1WeWMybHZiaUk2SWpFdU1pSXNJbU5vWVhKaFkzUmxjbDlpYjI5cklqcDdJbTVoYldVaU9pSk1ZVzF3YkdsbmFIUmxjaUJzYjNKbElpd2laR1Z6WTNKcGNIUnBiMjRpT2lKWGFHRjBJSFJvWlNCallYSmtJR3R1YjNkeklHRmliM1YwSUdsMGN5QnZkMjRnZDI5eWJHUXVJaXdpYzJOaGJsOWtaWEIwYUNJNk15d2lkRzlyWlc1ZlluVmtaMlYwSWpvMU1USXNJbkpsWTNWeWMybDJaVjl6WTJGdWJtbHVaeUk2Wm1Gc2MyVXNJbVY0ZEdWdWMybHZibk1pT25zaVptbDRkSFZ5WlNJNkltTm9ZWEpoWTNSbGNsOWliMjlySW4wc0ltVnVkSEpwWlhNaU9sdDdJbWxrSWpvd0xDSnJaWGx6SWpwYklteGhiWEFpTENKM2FXTnJJbDBzSW5ObFkyOXVaR0Z5ZVY5clpYbHpJanBiSW05cGJDSmRMQ0pqYjIxdFpXNTBJam9pVkdobElHeGhiWEFpTENKdVlXMWxJam9pVkdobElHeGhiWEFpTENKamIyNTBaVzUwSWpvaVZHaGxJR3hoYlhBZ1luVnlibk1nZDJoaGJHVWdiMmxzTENCaGJtUWdkR2hsSUhkcFkyc2dhWE1nZEhKcGJXMWxaQ0JoZENCa2RYTnJMaUlzSW1OdmJuTjBZVzUwSWpwbVlXeHpaU3dpYzJWc1pXTjBhWFpsSWpwMGNuVmxMQ0pwYm5ObGNuUnBiMjVmYjNKa1pYSWlPakV3TENKbGJtRmliR1ZrSWpwMGNuVmxMQ0p3YjNOcGRHbHZiaUk2SW1KbFptOXlaVjlqYUdGeUlpd2lZMkZ6WlY5elpXNXphWFJwZG1VaU9tWmhiSE5sTENKbGVIUmxibk5wYjI1eklqcDdmWDBzZXlKcFpDSTZNU3dpYTJWNWN5STZXeUowYVdSbElsMHNJbk5sWTI5dVpHRnllVjlyWlhseklqcGJYU3dpYm1GdFpTSTZJbFJvWlNCMGFXUmxJaXdpWTI5dWRHVnVkQ0k2SWxSb1pTQjBhV1JsSUdOdmJXVnpJR0YwSUdSMWMyc2dZVzVrSUhSaGEyVnpJSFJvWlNCc2IzY2djbTloWkM0aUxDSmpiMjV6ZEdGdWRDSTZkSEoxWlN3aWMyVnNaV04wYVhabElqcG1ZV3h6WlN3aWFXNXpaWEowYVc5dVgyOXlaR1Z5SWpveU1Dd2laVzVoWW14bFpDSTZabUZzYzJVc0luQnZjMmwwYVc5dUlqb2lZV1owWlhKZlkyaGhjaUlzSW1WNGRHVnVjMmx2Ym5NaU9uc2labWw0ZEhWeVpTSTZJbVZ1ZEhKNUluMTlYWDBzSW1WNGRHVnVjMmx2Ym5NaU9uc2lkR0ZzYTJGMGFYWmxibVZ6Y3lJNk1DNDJMQ0prWlhCMGFGOXdjbTl0Y0hRaU9uc2laR1Z3ZEdnaU9qUXNJbkJ5YjIxd2RDSTZJbE4wWVhrZ2FXNGdZMmhoY21GamRHVnlMaUo5TENKemJXRnlkSFJoZG1WeWJpSTZleUoyYjJsalpTSTZleUprWlhOcGNtVWlPall3TENKaFltbHNhWFI1SWpvME1Dd2ljbTlzWlhNaU9sc2liR1ZoWkNKZExDSnRZWGhNYVc1bGMxQmxjbEp2ZFc1a0lqb3lMQ0pqYjI5c1pHOTNiaUk2TVgwc0luWnBjM1ZoYkNJNmV5SmhjSEJsWVhKaGJtTmxJanA3SW1oaGFYSWlPaUpuY21WNUlpd2laWGxsY3lJNkltZHlaV1Z1SWl3aVluVnBiR1FpT2lKM2FYSjVJaXdpYzJ0cGJpSTZJbmRsWVhSb1pYSmxaQ0lzSW0xaGNtdHpJanBiSW1KMWNtNGdjMk5oY2lKZGZTd2liM1YwWm1sMGN5STZXM3NpYVdRaU9pSmtaV1poZFd4MElpd2libUZ0WlNJNklrUmxabUYxYkhRaUxDSndjbTl0Y0hRaU9pSnZhV3h6YTJsdUlHTnZZWFFpZlYwc0ltVjRjSEpsYzNOcGIyNXpJanBiZXlKcFpDSTZJbTVsZFhSeVlXd2lMQ0pzWVdKbGJDSTZJazVsZFhSeVlXd2lMQ0p3Y205dGNIUWlPaUpqWVd4dEluMWRMQ0p6ZEhsc1pTSTZleUp3Y21WelpYUWlPaUpzTVNJc0luQnZjMmwwYVhabElqb2lJaXdpYm1WbllYUnBkbVVpT2lJaUxDSmhjM0JsWTNRaU9pSTRNeko0TVRJeE5pSjlMQ0p3WVhKaGJYTWlPbnNpYzJWbFpGQnZiR2xqZVNJNkltWnBlR1ZrSWl3aWMyVmxaQ0k2TjMxOUxDSnpZVzF3YkdsdVp5STZleUowWlcxd1pYSmhkSFZ5WlNJNk1DNDVMQ0owYjNCUUlqb3dMamsxZlN3aVlTMW1kWFIxY21VdGJXVnRZbVZ5SWpwN0luZG9lU0k2SW1FZ1luVnBiR1FnZEdoaGRDQmthV1FnYm05MElHVjRhWE4wSUhsbGRDQjNjbTkwWlNCMGFHbHpJbjE5ZlgxOd+6TG4AAAAASUVORK5CYII=';

/** The base image plus `chara` (V2) and `ccv3` (V3), which ST writes for a V3 card. */
export const ST_CARD_V3_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAIAAAAmkwkpAAAABGdBTUEAALGPC/xhBQAAAAd0SU1FB+oJGwoAAPyUpX0AAAAmdEVYdFNvZnR3YXJlAFNpbGx5VGF2ZXJuIGZpeHR1cmUgZ2VuZXJhdG9yHN98+gAAABNJREFUeJxjFJJQYIABJjgLLwcAD2oAUmk0bs8AAAumdEVYdGNoYXJhAGV5SnpjR1ZqSWpvaVkyaGhjbUZmWTJGeVpGOTJNaUlzSW5Od1pXTmZkbVZ5YzJsdmJpSTZJakl1TUNJc0ltUmhkR0VpT25zaWJtRnRaU0k2SWtKeVlXMGdkR2hsSUV4aGJYQnNhV2RvZEdWeUlpd2laR1Z6WTNKcGNIUnBiMjRpT2lKTFpXVndjeUIwYUdVZ1UybHNkbVZ5Y0dsdVpTQnNhV2RvZENEaWdKUWdZVzVrSUdSdlpYTWdibTkwSUhSaGJHc2dZV0p2ZFhRZ2RHaGxJSFJwWkdVdUlNT0piM2Q1YmlkeklHTnZkWE5wYmk0aUxDSndaWEp6YjI1aGJHbDBlU0k2SWtSMWRHbG1kV3dzSUhSbGNuTmxMQ0J6ZFhCbGNuTjBhWFJwYjNWeklpd2ljMk5sYm1GeWFXOGlPaUpVYUdVZ2JHRnRjR3hwWjJoMElISnZiMjBnWVhRZ1pIVnpheUlzSW1acGNuTjBYMjFsY3lJNklsUm9aU0IzYVdOcklHbHpJR3h2ZHl3Z1lXNWtJSFJvWlNCM2FXNWtJR2x6SUhSMWNtNXBibWN1SVBDZmxhOGlMQ0p0WlhOZlpYaGhiWEJzWlNJNklqeFRWRUZTVkQ1Y2JudDdkWE5sY24xOU9pQkpjeUIwYUdVZ2JHbG5hSFFnWkhscGJtYy9YRzU3ZTJOb1lYSjlmVG9nUlhabGNubDBhR2x1WnlCa2FXVnpMQ0J6Ykc5M2JIa3VJaXdpWTNKbFlYUnZjbDl1YjNSbGN5STZJa0VnY1hWcFpYUWdZMkZ5WkN3Z2EyVndkQ0JtYjNJZ2NtOTFibVF0ZEhKcGNDQjBaWE4wY3k0aUxDSnplWE4wWlcxZmNISnZiWEIwSWpvaVUzUmhlU0JwYmlCamFHRnlZV04wWlhJN0lHNWxkbVZ5SUhOd1pXRnJJR1p2Y2lCMGFHVWdjR3hoZVdWeUxpSXNJbkJ2YzNSZmFHbHpkRzl5ZVY5cGJuTjBjblZqZEdsdmJuTWlPaUpMWldWd0lISmxjR3hwWlhNZ2RXNWtaWElnZEdoeVpXVWdjR0Z5WVdkeVlYQm9jeTRpTENKaGJIUmxjbTVoZEdWZlozSmxaWFJwYm1keklqcGJJbFJvWlNCa2IyOXlJRzl3Wlc1eklHSmxabTl5WlNCNWIzVWdhMjV2WTJzdUlpd2lVbUZwYml3Z1lXNWtJSFJvWlNCc1lXMXdJR0ZzY21WaFpIa2diR2wwTGlKZExDSjBZV2R6SWpwYkltTnlaWGNpTENKc2FXZG9kR2h2ZFhObElpd2labWw0ZEhWeVpTSmRMQ0pqY21WaGRHOXlJam9pWm1sNGRIVnlaUzFoZFhSb2IzSWlMQ0pqYUdGeVlXTjBaWEpmZG1WeWMybHZiaUk2SWpFdU1pSXNJbU5vWVhKaFkzUmxjbDlpYjI5cklqcDdJbTVoYldVaU9pSk1ZVzF3YkdsbmFIUmxjaUJzYjNKbElpd2laR1Z6WTNKcGNIUnBiMjRpT2lKWGFHRjBJSFJvWlNCallYSmtJR3R1YjNkeklHRmliM1YwSUdsMGN5QnZkMjRnZDI5eWJHUXVJaXdpYzJOaGJsOWtaWEIwYUNJNk15d2lkRzlyWlc1ZlluVmtaMlYwSWpvMU1USXNJbkpsWTNWeWMybDJaVjl6WTJGdWJtbHVaeUk2Wm1Gc2MyVXNJbVY0ZEdWdWMybHZibk1pT25zaVptbDRkSFZ5WlNJNkltTm9ZWEpoWTNSbGNsOWliMjlySW4wc0ltVnVkSEpwWlhNaU9sdDdJbWxrSWpvd0xDSnJaWGx6SWpwYklteGhiWEFpTENKM2FXTnJJbDBzSW5ObFkyOXVaR0Z5ZVY5clpYbHpJanBiSW05cGJDSmRMQ0pqYjIxdFpXNTBJam9pVkdobElHeGhiWEFpTENKdVlXMWxJam9pVkdobElHeGhiWEFpTENKamIyNTBaVzUwSWpvaVZHaGxJR3hoYlhBZ1luVnlibk1nZDJoaGJHVWdiMmxzTENCaGJtUWdkR2hsSUhkcFkyc2dhWE1nZEhKcGJXMWxaQ0JoZENCa2RYTnJMaUlzSW1OdmJuTjBZVzUwSWpwbVlXeHpaU3dpYzJWc1pXTjBhWFpsSWpwMGNuVmxMQ0pwYm5ObGNuUnBiMjVmYjNKa1pYSWlPakV3TENKbGJtRmliR1ZrSWpwMGNuVmxMQ0p3YjNOcGRHbHZiaUk2SW1KbFptOXlaVjlqYUdGeUlpd2lZMkZ6WlY5elpXNXphWFJwZG1VaU9tWmhiSE5sTENKbGVIUmxibk5wYjI1eklqcDdmWDBzZXlKcFpDSTZNU3dpYTJWNWN5STZXeUowYVdSbElsMHNJbk5sWTI5dVpHRnllVjlyWlhseklqcGJYU3dpYm1GdFpTSTZJbFJvWlNCMGFXUmxJaXdpWTI5dWRHVnVkQ0k2SWxSb1pTQjBhV1JsSUdOdmJXVnpJR0YwSUdSMWMyc2dZVzVrSUhSaGEyVnpJSFJvWlNCc2IzY2djbTloWkM0aUxDSmpiMjV6ZEdGdWRDSTZkSEoxWlN3aWMyVnNaV04wYVhabElqcG1ZV3h6WlN3aWFXNXpaWEowYVc5dVgyOXlaR1Z5SWpveU1Dd2laVzVoWW14bFpDSTZabUZzYzJVc0luQnZjMmwwYVc5dUlqb2lZV1owWlhKZlkyaGhjaUlzSW1WNGRHVnVjMmx2Ym5NaU9uc2labWw0ZEhWeVpTSTZJbVZ1ZEhKNUluMTlYWDBzSW1WNGRHVnVjMmx2Ym5NaU9uc2lkR0ZzYTJGMGFYWmxibVZ6Y3lJNk1DNDJMQ0prWlhCMGFGOXdjbTl0Y0hRaU9uc2laR1Z3ZEdnaU9qUXNJbkJ5YjIxd2RDSTZJbE4wWVhrZ2FXNGdZMmhoY21GamRHVnlMaUo5TENKemJXRnlkSFJoZG1WeWJpSTZleUoyYjJsalpTSTZleUprWlhOcGNtVWlPall3TENKaFltbHNhWFI1SWpvME1Dd2ljbTlzWlhNaU9sc2liR1ZoWkNKZExDSnRZWGhNYVc1bGMxQmxjbEp2ZFc1a0lqb3lMQ0pqYjI5c1pHOTNiaUk2TVgwc0luWnBjM1ZoYkNJNmV5SmhjSEJsWVhKaGJtTmxJanA3SW1oaGFYSWlPaUpuY21WNUlpd2laWGxsY3lJNkltZHlaV1Z1SWl3aVluVnBiR1FpT2lKM2FYSjVJaXdpYzJ0cGJpSTZJbmRsWVhSb1pYSmxaQ0lzSW0xaGNtdHpJanBiSW1KMWNtNGdjMk5oY2lKZGZTd2liM1YwWm1sMGN5STZXM3NpYVdRaU9pSmtaV1poZFd4MElpd2libUZ0WlNJNklrUmxabUYxYkhRaUxDSndjbTl0Y0hRaU9pSnZhV3h6YTJsdUlHTnZZWFFpZlYwc0ltVjRjSEpsYzNOcGIyNXpJanBiZXlKcFpDSTZJbTVsZFhSeVlXd2lMQ0pzWVdKbGJDSTZJazVsZFhSeVlXd2lMQ0p3Y205dGNIUWlPaUpqWVd4dEluMWRMQ0p6ZEhsc1pTSTZleUp3Y21WelpYUWlPaUpzTVNJc0luQnZjMmwwYVhabElqb2lJaXdpYm1WbllYUnBkbVVpT2lJaUxDSmhjM0JsWTNRaU9pSTRNeko0TVRJeE5pSjlMQ0p3WVhKaGJYTWlPbnNpYzJWbFpGQnZiR2xqZVNJNkltWnBlR1ZrSWl3aWMyVmxaQ0k2TjMxOUxDSnpZVzF3YkdsdVp5STZleUowWlcxd1pYSmhkSFZ5WlNJNk1DNDVMQ0owYjNCUUlqb3dMamsxZlN3aVlTMW1kWFIxY21VdGJXVnRZbVZ5SWpwN0luZG9lU0k2SW1FZ1luVnBiR1FnZEdoaGRDQmthV1FnYm05MElHVjRhWE4wSUhsbGRDQjNjbTkwWlNCMGFHbHpJbjE5ZlgxOd+6TG4AAA1RdEVYdGNjdjMAZXlKemNHVmpJam9pWTJoaGNtRmZZMkZ5WkY5Mk15SXNJbk53WldOZmRtVnljMmx2YmlJNklqTXVNQ0lzSW1SaGRHRWlPbnNpYm1GdFpTSTZJa0p5WVcwZ2RHaGxJRXhoYlhCc2FXZG9kR1Z5SWl3aVpHVnpZM0pwY0hScGIyNGlPaUpMWldWd2N5QjBhR1VnVTJsc2RtVnljR2x1WlNCc2FXZG9kQ0RpZ0pRZ1lXNWtJR1J2WlhNZ2JtOTBJSFJoYkdzZ1lXSnZkWFFnZEdobElIUnBaR1V1SU1PSmIzZDViaWR6SUdOdmRYTnBiaTRpTENKd1pYSnpiMjVoYkdsMGVTSTZJa1IxZEdsbWRXd3NJSFJsY25ObExDQnpkWEJsY25OMGFYUnBiM1Z6SWl3aWMyTmxibUZ5YVc4aU9pSlVhR1VnYkdGdGNHeHBaMmgwSUhKdmIyMGdZWFFnWkhWemF5SXNJbVpwY25OMFgyMWxjeUk2SWxSb1pTQjNhV05ySUdseklHeHZkeXdnWVc1a0lIUm9aU0IzYVc1a0lHbHpJSFIxY201cGJtY3VJUENmbGE4aUxDSnRaWE5mWlhoaGJYQnNaU0k2SWp4VFZFRlNWRDVjYm50N2RYTmxjbjE5T2lCSmN5QjBhR1VnYkdsbmFIUWdaSGxwYm1jL1hHNTdlMk5vWVhKOWZUb2dSWFpsY25sMGFHbHVaeUJrYVdWekxDQnpiRzkzYkhrdUlpd2lZM0psWVhSdmNsOXViM1JsY3lJNklrRWdjWFZwWlhRZ1kyRnlaQ3dnYTJWd2RDQm1iM0lnY205MWJtUXRkSEpwY0NCMFpYTjBjeTRpTENKemVYTjBaVzFmY0hKdmJYQjBJam9pVTNSaGVTQnBiaUJqYUdGeVlXTjBaWEk3SUc1bGRtVnlJSE53WldGcklHWnZjaUIwYUdVZ2NHeGhlV1Z5TGlJc0luQnZjM1JmYUdsemRHOXllVjlwYm5OMGNuVmpkR2x2Ym5NaU9pSkxaV1Z3SUhKbGNHeHBaWE1nZFc1a1pYSWdkR2h5WldVZ2NHRnlZV2R5WVhCb2N5NGlMQ0poYkhSbGNtNWhkR1ZmWjNKbFpYUnBibWR6SWpwYklsUm9aU0JrYjI5eUlHOXdaVzV6SUdKbFptOXlaU0I1YjNVZ2EyNXZZMnN1SWl3aVVtRnBiaXdnWVc1a0lIUm9aU0JzWVcxd0lHRnNjbVZoWkhrZ2JHbDBMaUpkTENKMFlXZHpJanBiSW1OeVpYY2lMQ0pzYVdkb2RHaHZkWE5sSWl3aVptbDRkSFZ5WlNKZExDSmpjbVZoZEc5eUlqb2labWw0ZEhWeVpTMWhkWFJvYjNJaUxDSmphR0Z5WVdOMFpYSmZkbVZ5YzJsdmJpSTZJakV1TWlJc0ltTm9ZWEpoWTNSbGNsOWliMjlySWpwN0ltNWhiV1VpT2lKTVlXMXdiR2xuYUhSbGNpQnNiM0psSWl3aVpHVnpZM0pwY0hScGIyNGlPaUpYYUdGMElIUm9aU0JqWVhKa0lHdHViM2R6SUdGaWIzVjBJR2wwY3lCdmQyNGdkMjl5YkdRdUlpd2ljMk5oYmw5a1pYQjBhQ0k2TXl3aWRHOXJaVzVmWW5Wa1oyVjBJam8xTVRJc0luSmxZM1Z5YzJsMlpWOXpZMkZ1Ym1sdVp5STZabUZzYzJVc0ltVjRkR1Z1YzJsdmJuTWlPbnNpWm1sNGRIVnlaU0k2SW1Ob1lYSmhZM1JsY2w5aWIyOXJJbjBzSW1WdWRISnBaWE1pT2x0N0ltbGtJam93TENKclpYbHpJanBiSW14aGJYQWlMQ0ozYVdOcklsMHNJbk5sWTI5dVpHRnllVjlyWlhseklqcGJJbTlwYkNKZExDSmpiMjF0Wlc1MElqb2lWR2hsSUd4aGJYQWlMQ0p1WVcxbElqb2lWR2hsSUd4aGJYQWlMQ0pqYjI1MFpXNTBJam9pVkdobElHeGhiWEFnWW5WeWJuTWdkMmhoYkdVZ2IybHNMQ0JoYm1RZ2RHaGxJSGRwWTJzZ2FYTWdkSEpwYlcxbFpDQmhkQ0JrZFhOckxpSXNJbU52Ym5OMFlXNTBJanBtWVd4elpTd2ljMlZzWldOMGFYWmxJanAwY25WbExDSnBibk5sY25ScGIyNWZiM0prWlhJaU9qRXdMQ0psYm1GaWJHVmtJanAwY25WbExDSndiM05wZEdsdmJpSTZJbUpsWm05eVpWOWphR0Z5SWl3aVkyRnpaVjl6Wlc1emFYUnBkbVVpT21aaGJITmxMQ0psZUhSbGJuTnBiMjV6SWpwN2ZYMHNleUpwWkNJNk1Td2lhMlY1Y3lJNld5SjBhV1JsSWwwc0luTmxZMjl1WkdGeWVWOXJaWGx6SWpwYlhTd2libUZ0WlNJNklsUm9aU0IwYVdSbElpd2lZMjl1ZEdWdWRDSTZJbFJvWlNCMGFXUmxJR052YldWeklHRjBJR1IxYzJzZ1lXNWtJSFJoYTJWeklIUm9aU0JzYjNjZ2NtOWhaQzRpTENKamIyNXpkR0Z1ZENJNmRISjFaU3dpYzJWc1pXTjBhWFpsSWpwbVlXeHpaU3dpYVc1elpYSjBhVzl1WDI5eVpHVnlJam95TUN3aVpXNWhZbXhsWkNJNlptRnNjMlVzSW5CdmMybDBhVzl1SWpvaVlXWjBaWEpmWTJoaGNpSXNJbVY0ZEdWdWMybHZibk1pT25zaVptbDRkSFZ5WlNJNkltVnVkSEo1SW4xOVhYMHNJbVY0ZEdWdWMybHZibk1pT25zaWRHRnNhMkYwYVhabGJtVnpjeUk2TUM0MkxDSmtaWEIwYUY5d2NtOXRjSFFpT25zaVpHVndkR2dpT2pRc0luQnliMjF3ZENJNklsTjBZWGtnYVc0Z1kyaGhjbUZqZEdWeUxpSjlMQ0p6YldGeWRIUmhkbVZ5YmlJNmV5SjJiMmxqWlNJNmV5SmtaWE5wY21VaU9qWXdMQ0poWW1sc2FYUjVJam8wTUN3aWNtOXNaWE1pT2xzaWJHVmhaQ0pkTENKdFlYaE1hVzVsYzFCbGNsSnZkVzVrSWpveUxDSmpiMjlzWkc5M2JpSTZNWDBzSW5acGMzVmhiQ0k2ZXlKaGNIQmxZWEpoYm1ObElqcDdJbWhoYVhJaU9pSm5jbVY1SWl3aVpYbGxjeUk2SW1keVpXVnVJaXdpWW5WcGJHUWlPaUozYVhKNUlpd2ljMnRwYmlJNkluZGxZWFJvWlhKbFpDSXNJbTFoY210eklqcGJJbUoxY200Z2MyTmhjaUpkZlN3aWIzVjBabWwwY3lJNlczc2lhV1FpT2lKa1pXWmhkV3gwSWl3aWJtRnRaU0k2SWtSbFptRjFiSFFpTENKd2NtOXRjSFFpT2lKdmFXeHphMmx1SUdOdllYUWlmVjBzSW1WNGNISmxjM05wYjI1eklqcGJleUpwWkNJNkltNWxkWFJ5WVd3aUxDSnNZV0psYkNJNklrNWxkWFJ5WVd3aUxDSndjbTl0Y0hRaU9pSmpZV3h0SW4xZExDSnpkSGxzWlNJNmV5SndjbVZ6WlhRaU9pSnNNU0lzSW5CdmMybDBhWFpsSWpvaUlpd2libVZuWVhScGRtVWlPaUlpTENKaGMzQmxZM1FpT2lJNE16SjRNVEl4TmlKOUxDSndZWEpoYlhNaU9uc2ljMlZsWkZCdmJHbGplU0k2SW1acGVHVmtJaXdpYzJWbFpDSTZOMzE5TENKellXMXdiR2x1WnlJNmV5SjBaVzF3WlhKaGRIVnlaU0k2TUM0NUxDSjBiM0JRSWpvd0xqazFmU3dpWVMxbWRYUjFjbVV0YldWdFltVnlJanA3SW5kb2VTSTZJbUVnWW5WcGJHUWdkR2hoZENCa2FXUWdibTkwSUdWNGFYTjBJSGxsZENCM2NtOTBaU0IwYUdsekluMTlmU3dpYm1samEyNWhiV1VpT2lKQ2NtRnRJaXdpWTNKbFlYUnZjbDl1YjNSbGMxOXRkV3gwYVd4cGJtZDFZV3dpT25zaVpuSWlPaUpWYm1VZ1kyRnlkR1VnZEhKaGJuRjFhV3hzWlM0aWZTd2ljMjkxY21ObElqcGJJbWgwZEhCek9pOHZaWGhoYlhCc1pTNXBiblpoYkdsa0wySnlZVzBpWFN3aVozSnZkWEJmYjI1c2VWOW5jbVZsZEdsdVozTWlPbHNpVkdobElISnZiMjBnYVhNZ1lXeHlaV0ZrZVNCbWRXeHNJSGRvWlc0Z2VXOTFJR0Z5Y21sMlpTNGlYU3dpWTNKbFlYUnBiMjVmWkdGMFpTSTZNVGMyTURBd01EQXdNQ3dpYlc5a2FXWnBZMkYwYVc5dVgyUmhkR1VpT2pFM05qQXdNREE1TURBc0ltRnpjMlYwY3lJNlczc2lkSGx3WlNJNkltbGpiMjRpTENKMWNta2lPaUpqWTJSbFptRjFiSFE2SWl3aWJtRnRaU0k2SW0xaGFXNGlMQ0psZUhRaU9pSndibWNpZlYxOWZRPT3h2sJTAAAAAElFTkSuQmCC';
