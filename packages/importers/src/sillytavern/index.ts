/**
 * The SillyTavern adapter barrel (`docs/06` §2.6 M1-I1, `docs/01` F9-1…F9-3).
 *
 * LAYOUT, AND WHY THE SPLIT IS THIS ONE
 *   ./findings          the report vocabulary and the one severity table
 *   ./json              tolerant readers for other people's JSON
 *   ./base64            the `chara` payload codec, alphabet and failure as a reason
 *   ./png               chunk walk, CRC, `tEXt` bodies, replace-in-place surgery
 *   ./character-card    the card JSON ⇄ `CharacterData` mapping
 *   ./character-png     the card inside a PNG (uses the two above)
 *   ./worldbook         ST world info / `character_book` ⇄ `WorldbookEntry[]`
 *
 * WHAT THIS LAYER DOES NOT DO: it never touches storage, the network or the clock.
 * It maps PAYLOADS — `importStCharacterCardJson` answers a `CharacterData`, exactly
 * the shape `packages/schema` froze — and ids, versions and timestamps are the
 * store's business (`./payload.ts` splits them the same way for `.stpack`). A
 * caller that wants a row writes it through `StorageAdapter.transaction`, or wraps
 * the payload in a `CharacterVersion` the way `import-package.ts` does for a
 * package. Keeping the mapping pure is what makes the round-trip tests below
 * statements about FIELDS rather than about a database.
 */
export * from './base64';
export * from './character-card';
export * from './character-png';
export * from './findings';
export * from './json';
export * from './png';
export * from './worldbook';
