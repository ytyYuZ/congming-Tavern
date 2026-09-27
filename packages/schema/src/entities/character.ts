/**
 * Character card — the most consequential entity in the project (docs/02 §13
 * item 4, HANDOFF §5 M0-T1 "★ 最核心").
 *
 * TWO RULES THAT ARE EASY TO GET WRONG
 *
 * 1. There is NO player/cast field. A card is a card; which one is the player is
 *    a property of the SESSION (`Session.refs.playerCharacter`, ADR-010). The
 *    same card plays different roles in different sessions, so nothing here may
 *    ever grow an `isPlayer`/`kind` field.
 *
 * 2. The SillyTavern-facing fields keep their exact upstream names, snake_case
 *    included (`first_mes`, `mes_example`, `alternate_greetings`, ...). Renaming
 *    them for tidiness would silently break every imported character card and
 *    the ST round-trip in docs/04 §10. Our own additions are camelCase and live
 *    under `voice` / `visual` / `sampling`, which export into the ST card's
 *    `extensions.smarttavern` bucket (docs/04 §10).
 */
import { z } from 'zod';
import {
  ExtensionsSchema,
  IdSchema,
  PartialSamplingParamsSchema,
  TimestampSchema,
  UuidV7Schema,
  VersionNumberSchema,
} from '../common';
import { versionedEntity } from '../versioning';

/* ─────────────────── 发言档案：谁想说话、能说多久（ADR-011） ──────────────── */

/**
 * Speaking profile. Scoring stays in the local `TurnScheduler`; this is only the
 * parameter set the user tunes. Both numbers are 0-100 so the UI can show a
 * plain slider and the scheduler can compare card against card.
 */
export const VoiceProfileSchema = z.object({
  /** 发言欲望 0-100. */
  desire: z.number().min(0).max(100),
  /** 发言能力 0-100. */
  ability: z.number().min(0).max(100),
  /** 发言角色标签（主角 / 配角 / 反派…），供规则匹配，不做枚举以允许自定义。 */
  roles: z.array(z.string()),
  /** 单轮条数上限 1-5：硬约束，AI 不能突破。 */
  maxLinesPerRound: z.number().int().min(1).max(5),
  /** 冷却轮数 0-3：硬约束。 */
  cooldown: z.number().int().min(0).max(3),
});
export type VoiceProfile = z.infer<typeof VoiceProfileSchema>;

/* ───────────────────── 视觉档案：生图一致性的根基（ADR-014） ─────────────── */

/**
 * The visual bible. L1 (fixed seed + fixed base prompt) is the shipping
 * strategy, which is why `style` and `params` are first-class rather than being
 * free text inside a single prompt string: consistency depends on these staying
 * byte-stable across generations.
 */
export const VisualBibleSchema = z.object({
  appearance: z.object({
    hair: z.string(),
    eyes: z.string(),
    build: z.string(),
    skin: z.string(),
    /** 印记 / 疤痕 / 纹身等识别特征，逐条列出便于增删。 */
    marks: z.array(z.string()),
  }),
  /** 服装差分：id 稳定，prompt 可重生成。 */
  outfits: z.array(
    z.object({
      id: IdSchema,
      name: z.string(),
      prompt: z.string(),
    }),
  ),
  /** 表情差分（颜绘）。 */
  expressions: z.array(
    z.object({
      id: IdSchema,
      label: z.string(),
      prompt: z.string(),
    }),
  ),
  style: z.object({
    preset: z.string(),
    positive: z.string(),
    negative: z.string(),
    /** 画幅，如 `832x1216`；自由字符串以便接入任意 Provider。 */
    aspect: z.string(),
  }),
  params: z.object({
    provider: z.string().optional(),
    model: z.string().optional(),
    sampler: z.string().optional(),
    steps: z.number().int().positive().optional(),
    cfg: z.number().positive().optional(),
    /**
     * L1 consistency depends on this: `fixed` reuses `seed`, `increment` walks
     * it forward, `random` gives up reproducibility on purpose.
     */
    seedPolicy: z.enum(['fixed', 'random', 'increment']),
    seed: z.number().int().optional(),
  }),
  /** 参考图（L2/L3 的输入），指向内容寻址的 asset。 */
  references: z
    .array(
      z.object({
        assetId: IdSchema,
        role: z.enum(['face', 'outfit', 'style']),
      }),
    )
    .optional(),
});
export type VisualBible = z.infer<typeof VisualBibleSchema>;

/* ──────────────────────────────── 角色数据 ───────────────────────────────── */

/**
 * The card payload. See the file header: the snake_case block is SillyTavern's
 * V2/V3 field set and must not be renamed.
 */
export const CharacterDataSchema = z.object({
  /* ── SillyTavern V2/V3 兼容字段（字段名必须与上游一致） ── */
  name: z.string().min(1).max(200),
  description: z.string(),
  personality: z.string(),
  scenario: z.string(),
  first_mes: z.string(),
  mes_example: z.string(),
  creator_notes: z.string(),
  system_prompt: z.string(),
  post_history_instructions: z.string(),
  alternate_greetings: z.array(z.string()),
  tags: z.array(z.string()),
  creator: z.string(),
  character_version: z.string(),

  /* ── SmartTavern 扩展（导出时写入 ST 卡片的 extensions.smarttavern） ── */
  voice: VoiceProfileSchema,
  visual: VisualBibleSchema,
  sampling: PartialSamplingParamsSchema.optional(),

  /**
   * Foreign SillyTavern extensions, stored verbatim.
   *
   * ST cards carry a free-form `extensions` object owned by other people's
   * scripts (`talkativeness`, `depth_prompt`, …). Keys are NOT `x-` namespaced,
   * so they cannot live in our `extensions` bag — but dropping them would break
   * the import -> export round-trip that docs/04 §10 promises. Mapped back to the
   * ST field named `extensions` on export.
   */
  stExtensions: z.record(z.string(), z.unknown()).optional(),

  /** 自定义字段（用户自填的键值），与世界卡保持一致的做法。 */
  customFields: z.record(z.string(), z.string()).optional(),
});
export type CharacterData = z.infer<typeof CharacterDataSchema>;

/**
 * Immutable version row (`characterVersions`, docs/02 §7):
 * envelope + `characterId` back-pointer + the payload.
 */
export const CharacterVersionSchema = versionedEntity(CharacterDataSchema).extend({
  characterId: UuidV7Schema,
});
export type CharacterVersion = z.infer<typeof CharacterVersionSchema>;

/**
 * Head row (`characters`, docs/02 §7): what the library lists and searches
 * without loading every version payload.
 */
export const CharacterSchema = z.object({
  id: UuidV7Schema,
  name: z.string().min(1).max(200),
  headVersion: VersionNumberSchema,
  tags: z.array(z.string()),
  /** 头像 asset（可选）：列表页不加载全部差分图。 */
  avatarAssetId: IdSchema.optional(),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
  extensions: ExtensionsSchema.optional(),
});
export type Character = z.infer<typeof CharacterSchema>;
