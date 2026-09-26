# tools/schema-export

Placeholder home for the JSON Schema export step (M0-T2).

`docs/06-开发任务拆解.md` M0-T2 requires `packages/schema/package.ts` to be the
*only* hand-written definition of the `.stpack` manifest, from which a JSON
Schema is generated and committed as `schema/package-1.json` so third-party
implementations can validate against the same contract. **禁止手写第二份
schema** — a second hand-written copy is forbidden.

Planned layout (filled in during M0-T2):

- `src/index.ts` — reads the Zod schema from `@smarttavern/schema` and emits
  JSON Schema (`zod-to-json-schema`, or Zod v4's native `z.toJSONSchema`).
- `package.json` — a `@smarttavern/schema-export` workspace, private, with a
  `build` script wired into the root `build` step once it exists.

Nothing here is executable yet; M0-T0 only reserves the directory so the layout
matches `docs/02-技术架构.md` §3.
