/**
 * Image provider double: the submit → poll → asset-id loop that §5.5's pipeline
 * has to drive, plus cancellation.
 */
import { describe, expect, it } from 'vitest';
import type { ImageJob } from '../image';
import { MOCK_IMAGE_CAPABILITIES, MockImageProvider } from './index';

const JOB: ImageJob = {
  prompt: 'a tavern at dusk, oil painting',
  mode: 'txt2img',
  width: 512,
  height: 768,
  seed: 1234,
};

describe('MockImageProvider', () => {
  it('submits a job, records it, and reports progress to a terminal state', async () => {
    const provider = new MockImageProvider();
    const { jobId } = await provider.submit(JOB, new AbortController().signal);

    expect(provider.submissions).toEqual([JOB]);
    expect((await provider.poll(jobId)).state).toBe('pending');

    const done = await provider.runToCompletion(jobId);
    expect(done.state).toBe('succeeded');
    expect(done.progress).toBe(1);
    expect(done.assetIds).toEqual([`${jobId}-asset-1`]);
  });

  it('advertises the modes and limits the pipeline needs to pick a strategy', () => {
    const provider = new MockImageProvider();
    expect(provider.capabilities.modes).toContain('inpaint');
    expect(provider.capabilities.controlnet).toBe(true);
    expect(provider.capabilities.maxBatch).toBeGreaterThan(1);
    expect(provider.capabilities.aspectRatios).toContain('1:1');
    expect(provider.capabilities.progress).toBe(true);
    expect(MOCK_IMAGE_CAPABILITIES).toEqual(provider.capabilities);
  });

  it('can report several assets per job, in submit order', async () => {
    const provider = new MockImageProvider({ assetsPerJob: 3 });
    const { jobId } = await provider.submit({ ...JOB, batch: 3 }, new AbortController().signal);
    const done = await provider.runToCompletion(jobId);
    expect(done.assetIds).toEqual([`${jobId}-asset-1`, `${jobId}-asset-2`, `${jobId}-asset-3`]);
  });

  it('stops at a cancelled job instead of finishing it', async () => {
    const provider = new MockImageProvider();
    const { jobId } = await provider.submit(JOB, new AbortController().signal);

    provider.advance(jobId);
    await provider.cancel(jobId);

    expect(await provider.poll(jobId)).toMatchObject({ state: 'cancelled' });
    expect(provider.advance(jobId)).toBe('cancelled');
  });

  it('reports a scripted failure with the provider error text', async () => {
    const provider = new MockImageProvider({
      transitions: ['pending', 'running', 'failed'],
      error: 'NSFW filter rejected the prompt',
    });
    const { jobId } = await provider.submit(JOB, new AbortController().signal);
    const failed = await provider.runToCompletion(jobId);

    expect(failed).toMatchObject({ state: 'failed', error: 'NSFW filter rejected the prompt' });
  });

  it('reports an unknown job as failed rather than throwing', async () => {
    const provider = new MockImageProvider();
    expect(await provider.poll('nope')).toMatchObject({ state: 'failed' });
    expect(provider.stateOf('nope')).toBeUndefined();
  });

  it('accepts no job when the signal was already aborted', async () => {
    const provider = new MockImageProvider();
    const controller = new AbortController();
    controller.abort();

    const { jobId } = await provider.submit(JOB, controller.signal);

    expect(jobId).toBe('');
    expect(provider.submissions).toEqual([]);
    expect(provider.jobCount).toBe(0);
  });
});
