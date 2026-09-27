/**
 * Image port — `docs/02-技术架构.md` §6 (`ImageProvider`), §5.5 (pipeline), §7
 * (`jobs` collection).
 *
 * WHAT THIS FILE DECIDES
 * `ImageProvider` in §6 is three methods and a capability bag. The capability bag
 * is the load-bearing part: §5.5's consistency ladder (D6) can only pick "fixed
 * seed + fixed base prompt" over img2img over inpaint if it first knows which of
 * those the provider supports, and `maxBatch` / `aspectRatios` / `progress` are
 * what let the queue and the UI behave honestly instead of optimistically.
 *
 * WHERE THE QUEUE LIVES
 * NOT here. `submit` / `poll` / `cancel` are the provider's own vocabulary;
 * concurrency limits, exponential backoff and cancellation policy belong to
 * `packages/providers`' pipeline (M2). This file freezes the hand-off shape and
 * nothing else.
 *
 * TYPES REUSED FROM `schema` (ADR-016): an `ImageJob` payload is plain JSON, and
 * the asset it eventually produces is identified by `Id` — the same id space as
 * `entities/asset.ts`.
 */
import type { Id, JsonValue } from '@smarttavern/schema';

/** The three generation modes of §6, closed: a provider switches on them. */
export type ImageMode = 'txt2img' | 'img2img' | 'inpaint';

/**
 * What a provider can do. `controlnet` and `reference` are separate flags
 * because they are separate capabilities (a provider may support one, not the
 * other); `progress` says whether `poll` can do better than "queued / done".
 */
export interface ImageCapabilities {
  modes: ImageMode[];
  controlnet: boolean;
  /** Character/art reference sheets, i.e. NovelAI-style `reference` or IP-Adapters. */
  reference: boolean;
  /** Upper bound on images per submit; 1 when the provider is strictly serial. */
  maxBatch: number;
  /** Ratio strings the provider accepts, e.g. `'1:1'`, `'3:4'`. */
  aspectRatios: string[];
  /** True when `poll` reports a percentage/fraction rather than only a state. */
  progress: boolean;
}

/**
 * A submitted generation request, already-resolved: §5.5 does prompt assembly,
 * parameter merging and the seed strategy BEFORE this point, so the provider
 * receives a plain request and cannot influence consistency policy.
 *
 * `params` is deliberately `JsonValue` and not a typed structure — every vendor
 * has its own sampler knobs, and freezing a common subset now would make the
 * providers that need more impossible to write (the same reasoning as
 * `AssetMeta.source.params`).
 */
export interface ImageJob {
  prompt: string;
  negativePrompt?: string;
  mode: ImageMode;
  /** Model or workflow template id, interpreted by the provider. */
  model?: string;
  width?: number;
  height?: number;
  /** CLI-visible reproducibility, per §5.4/§5.5 "可复现". */
  seed?: number;
  batch?: number;
  /** Source bytes for `img2img` / `inpaint`; required by those modes. */
  initImage?: Uint8Array;
  /** Mask for `inpaint`, aligned with `initImage`. */
  mask?: Uint8Array;
  /** Denoising strength for the image-to-image modes. */
  strength?: number;
  /** ControlNet / reference payloads, opaque to core. */
  control?: JsonValue;
  /** Vendor-specific sampler settings. */
  params?: Record<string, JsonValue>;
}

/**
 * Terminal and non-terminal states of a job. Closed on purpose: the queue, the
 * UI and the retry logic all switch on it exhaustively, so a plugin-invented
 * state would have nowhere to land (§7 `jobs.status` is the same distinction).
 */
export type ImageJobState = 'pending' | 'running' | 'succeeded' | 'failed' | 'cancelled';

/**
 * One `poll` answer. `progress` is optional and only meaningful when
 * `capabilities.progress` is true; `assetId` is set exactly once the bytes have
 * been stored through `AssetStore` (i.e. the provider itself does not write to
 * the asset store — the pipeline does).
 */
export interface ImageJobStatus {
  jobId: string;
  state: ImageJobState;
  /** 0..1 when reported; absent when the provider cannot say. */
  progress?: number;
  /** Ids of the produced assets, in submit order. */
  assetIds?: Id[];
  /** Human-readable failure reason; present when `state === 'failed'`. */
  error?: string;
  /** Vendor bookkeeping the debug panel shows (queue position, ETA, …). */
  meta?: Record<string, JsonValue>;
}

/**
 * The §6 provider contract. `cancel` is optional because a provider that cannot
 * cancel should not be forced to pretend it can; the pipeline treats a missing
 * `cancel` as "let it finish and discard".
 */
export interface ImageProvider {
  readonly id: string;
  readonly capabilities: ImageCapabilities;
  submit(job: ImageJob, signal: AbortSignal): Promise<{ jobId: string }>;
  poll(jobId: string): Promise<ImageJobStatus>;
  cancel?(jobId: string): Promise<void>;
}
