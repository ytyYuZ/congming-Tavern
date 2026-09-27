/**
 * In-memory `ImageProvider` double (docs/06 §8.4: one mock per port).
 *
 * WHAT IT PROVES
 * `submit` / `poll` / `cancel` is a state machine, and §5.5's pipeline has to
 * drive it: submit, poll until a terminal state, collect the asset ids. So the
 * double exposes an explicit `advance(jobId)` instead of a timer — timer-based
 * mocks make the pipeline's tests nondeterministic, and `docs/02` §11 asks for
 * reproducible runs.
 *
 * It also never writes to an `AssetStore`: per §6, the pipeline stores the bytes
 * and the provider only reports `assetIds`.
 */
import type {
  ImageCapabilities,
  ImageJob,
  ImageJobState,
  ImageJobStatus,
  ImageProvider,
} from '../image';
import { isAborted } from './_support';

/** Everything on, so no test is blocked by a capability flag. */
export const MOCK_IMAGE_CAPABILITIES: ImageCapabilities = {
  modes: ['txt2img', 'img2img', 'inpaint'],
  controlnet: true,
  reference: true,
  maxBatch: 4,
  aspectRatios: ['1:1', '3:4', '16:9'],
  progress: true,
};

/** The states a job walks through when it is advanced without a script. */
const DEFAULT_TRANSITIONS: readonly ImageJobState[] = ['pending', 'running', 'succeeded'];

export interface MockImageProviderOptions {
  id?: string;
  capabilities?: ImageCapabilities;
  /** States `poll` reports, in order; the last one is terminal and reused. */
  transitions?: readonly ImageJobState[];
  /** How many assets each successful job reports. */
  assetsPerJob?: number;
  /** Failure text for the `failed` state. */
  error?: string;
}

interface JobRecord {
  job: ImageJob;
  state: ImageJobState;
  steps: number;
  assetIds?: string[];
  cancelled: boolean;
}

export class MockImageProvider implements ImageProvider {
  readonly id: string;
  readonly capabilities: ImageCapabilities;

  /** Every submit, in order, so a test can assert the job it sent. */
  readonly submissions: ImageJob[] = [];

  private readonly transitions: readonly ImageJobState[];
  private readonly assetsPerJob: number;
  private readonly failureText: string;
  private readonly jobs = new Map<string, JobRecord>();
  private counter = 0;

  constructor(options: MockImageProviderOptions = {}) {
    this.id = options.id ?? 'mock-image';
    this.capabilities = options.capabilities ?? MOCK_IMAGE_CAPABILITIES;
    this.transitions = options.transitions ?? DEFAULT_TRANSITIONS;
    this.assetsPerJob = options.assetsPerJob ?? 1;
    this.failureText = options.error ?? 'mock generation failed';
  }

  async submit(job: ImageJob, signal: AbortSignal): Promise<{ jobId: string }> {
    if (isAborted(signal)) return { jobId: '' };
    this.counter += 1;
    const jobId = `job-${this.counter}`;
    this.submissions.push(job);
    this.jobs.set(jobId, {
      job,
      state: this.transitions[0] ?? 'pending',
      steps: 0,
      cancelled: false,
    });
    return { jobId };
  }

  async poll(jobId: string): Promise<ImageJobStatus> {
    const record = this.jobs.get(jobId);
    if (record === undefined) {
      return { jobId, state: 'failed', error: `unknown job ${jobId}` };
    }
    if (record.state === 'succeeded') {
      return {
        jobId,
        state: 'succeeded',
        progress: 1,
        ...(record.assetIds === undefined ? {} : { assetIds: record.assetIds }),
      };
    }
    if (record.state === 'failed') {
      return { jobId, state: 'failed', error: this.failureText };
    }
    return { jobId, state: record.state, progress: this.progressOf(record) };
  }

  async cancel(jobId: string): Promise<void> {
    const record = this.jobs.get(jobId);
    if (record === undefined) return;
    record.cancelled = true;
    record.state = 'cancelled';
  }

  /* ─────────────────────────── test conveniences ────────────────────────── */

  /**
   * Move a job one step along its transition list. Returns the new state, so a
   * test can loop `while (await advance(id) !== 'succeeded')`.
   */
  advance(jobId: string): ImageJobState {
    const record = this.jobs.get(jobId);
    if (record === undefined) throw new Error(`unknown job ${jobId}`);
    if (record.state === 'cancelled' || record.state === 'failed') return record.state;
    record.steps += 1;
    const index = Math.min(record.steps, this.transitions.length - 1);
    const next = this.transitions[index] ?? 'succeeded';
    record.state = next;
    if (next === 'succeeded') {
      record.assetIds = Array.from(
        { length: this.assetsPerJob },
        (_unused, offset) => `${jobId}-asset-${offset + 1}`,
      );
    }
    return next;
  }

  /** Drive a job to a terminal state, as a pipeline's poll loop would. */
  async runToCompletion(jobId: string): Promise<ImageJobStatus> {
    let status = await this.poll(jobId);
    while (status.state === 'pending' || status.state === 'running') {
      this.advance(jobId);
      status = await this.poll(jobId);
    }
    return status;
  }

  /** The state of a job without going through the port. */
  stateOf(jobId: string): ImageJobState | undefined {
    return this.jobs.get(jobId)?.state;
  }

  get jobCount(): number {
    return this.jobs.size;
  }

  private progressOf(record: JobRecord): number {
    const last = Math.max(this.transitions.length - 1, 1);
    return Math.min(record.steps / last, 1);
  }
}
