/**
 * Entity barrel. One file per entity, mirroring the `*Versions` / table
 * collections in docs/02 §7.
 *
 * Adding an entity is additive: create the file, export it here, done. Nothing
 * else in the codebase needs to know the list.
 */
export * from './agenda';
export * from './asset';
export * from './character';
export * from './checkpoint';
export * from './memory';
export * from './message';
export * from './session';
export * from './turn';
export * from './world';
export * from './worldbook';
