/**
 * Tool declarations (`docs/02-技术架构.md` §5.3, §13 contract #8).
 *
 * WHY THE DECLARATION LIVES IN `schema` AND THE RUNTIME IN `core/ports`:
 * a tool's signature is DATA. It is serialised into the prompt, it will ship
 * inside rule packs and plugin manifests, and `schema/tools-1.json` publishes it
 * to third parties — so it has to be a frozen contract (ADR-016 invariant 2).
 * What EXECUTES a tool is behaviour, and that belongs to
 * `packages/core/ports/tools.ts`.
 *
 * WHAT IS DELIBERATELY ABSENT
 * - No catalogue of concrete tools. The fifteen built-ins in §5.3 are M1–M3 work;
 *   inventing their parameter lists now would freeze guesses.
 * - No "where did this call come from" enum. `Message.toolCalls[].source` already
 *   owns that vocabulary (native → structured → text protocol, §5.3's degradation
 *   ladder); a second copy here is exactly the drift ADR-016 forbids.
 * - No decision/approval record. The rule that shapes every tool call is
 *   HANDOFF §4.1 invariant 3 — **the AI may request, never write** — and the
 *   local runtime that makes that decision is `core/ports`.
 */
import { z } from 'zod';
import { ExtensionsSchema, JsonValueSchema, openEnum } from './common';

/**
 * Tool name: lower-case, at most 64 characters, optionally namespaced with
 * `.`, `/` or `-` so a plugin can own `x-mythos/roll_sanity` without colliding
 * with a core tool.
 */
export const TOOL_NAME_PATTERN = /^[a-z0-9][a-z0-9_./-]{0,63}$/;
export const ToolNameSchema = z
  .string()
  .regex(TOOL_NAME_PATTERN, 'lower-case tool names, optionally namespaced with . / -');
export type ToolName = z.infer<typeof ToolNameSchema>;

/** Who declared the tool. OPEN: a plugin contributes under its `x-` namespace. */
export const ToolOwnerSchema = openEnum(['core', 'rulepack', 'user'] as const);
export type ToolOwner = z.infer<typeof ToolOwnerSchema>;

/** JSON Schema primitive kinds a parameter may use. */
export const ToolParameterTypeSchema = z.enum([
  'string',
  'number',
  'integer',
  'boolean',
  'array',
  'object',
]);
export type ToolParameterType = z.infer<typeof ToolParameterTypeSchema>;

/**
 * One parameter of a tool. Flat on purpose (not a nested JSON Schema): a provider
 * adapter can expand it into the vendor's own `parameters` shape, and the UI can
 * render a form from it without a JSON Schema renderer.
 */
export const ToolParameterSchema = z.object({
  name: z.string().regex(/^[a-z][a-z0-9_]*$/, 'snake_case parameter name'),
  type: ToolParameterTypeSchema,
  description: z.string().max(1000),
  required: z.boolean(),
  /** Closed value set, when the parameter is an enumeration. */
  values: z.array(JsonValueSchema).optional(),
  default: JsonValueSchema.optional(),
});
export type ToolParameter = z.infer<typeof ToolParameterSchema>;

/**
 * A tool an AI may *ask* to run. Every field exists so that the local runtime can
 * validate a call and decide whether it needs the user's approval BEFORE it
 * touches state (§5.3 execution model).
 */
export const ToolDefinitionSchema = z.object({
  name: ToolNameSchema,
  /** One line, shown to the model. */
  summary: z.string().min(1).max(500),
  /** Long form, shown to the user. */
  description: z.string().max(4000).optional(),
  parameters: z.array(ToolParameterSchema),
  owner: ToolOwnerSchema,
  /**
   * True when the tool changes application state. A stateless tool (dice, rule
   * lookup) can run on request; a mutating one must go through the local write
   * path and is auditable and reversible (§5.3).
   */
  mutatesState: z.boolean(),
  requiresApproval: z.boolean(),
  extensions: ExtensionsSchema.optional(),
});
export type ToolDefinition = z.infer<typeof ToolDefinitionSchema>;
