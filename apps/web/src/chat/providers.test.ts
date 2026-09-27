/**
 * The model list (M1-G3) — the URL rule, the four fetch outcomes, and the one decision the
 * feature had to make: what happens to a saved model that the endpoint no longer lists.
 *
 * WHY THE REAL ADAPTER IS DRIVEN FOR THE URL RULE
 * `modelsUrl` repeats a normalisation the adapter owns privately, so the only way to know the
 * two agree is to make the adapter actually request something and compare. Every case below
 * therefore runs `OpenAICompatibleProvider.listModels()` over a fake transport, records the
 * URL it asked for, and asserts `modelsUrl` builds the same string. A mocked adapter would
 * only prove this file can call a function.
 *
 * WHY THE PICKER DOES NOT USE `listModels()`
 * Its contract is "never throws, substitute the vendor's well-known ids on failure", which
 * makes an unreachable endpoint, a 401 and an EMPTY list indistinguishable — all three come
 * back as a plausible list. `listProviderModels` reads the same URL and reports which happened,
 * and the "never invents a model" test below is what pins that difference.
 *
 * WHY THE SAVED-MODEL CASE IS A TEST AND NOT ONLY A COMMENT
 * "Keep it and flag it" is the kind of decision a later reader "helpfully" reverses (rewrite the
 * field to the first id in the list — it looks tidier). These assertions fail if that happens:
 * the saved id stays in the choices, and the fetch result never supplies it.
 */
import { OpenAICompatibleProvider } from '@smarttavern/providers';
import { describe, expect, it } from 'vitest';
import {
  listProviderModels,
  MODEL_OPTION_LIMIT,
  type ModelListResult,
  modelChoices,
  modelListNote,
  modelsUrl,
} from './providers';

const KEY = 'sk-model-list-must-not-leak';
const MODEL = 'test-model-1';

/** A transport that answers one canned response and records what it was asked for. */
function wire(response: () => Response): {
  fetch: (url: string, init: RequestInit) => Promise<Response>;
  urls: string[];
  authorizations: (string | undefined)[];
} {
  const urls: string[] = [];
  const authorizations: (string | undefined)[] = [];
  return {
    urls,
    authorizations,
    fetch: (url, init) => {
      urls.push(url);
      authorizations.push(new Headers(init.headers).get('authorization') ?? undefined);
      return Promise.resolve(response());
    },
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** Run the REAL adapter's `listModels()` so the URL it uses can be compared. */
async function adapterModelsUrl(baseUrl: string): Promise<string> {
  const fake = wire(() => jsonResponse({ data: [{ id: MODEL }] }));
  const provider = new OpenAICompatibleProvider({
    baseUrl,
    apiKey: KEY,
    model: MODEL,
    fetch: fake.fetch,
  });
  await provider.listModels();
  const requested = fake.urls[0];
  if (requested === undefined) throw new Error('the adapter made no request');
  return requested;
}

describe('modelsUrl is the adapter’s own rule', () => {
  const BASES = [
    'https://gateway.test',
    'https://gateway.test/',
    'http://localhost:11434',
    'http://localhost:11434/',
    'https://gateway.test/v1',
    'https://gateway.test/v1/',
    'https://gateway.test/openai/v1',
    'https://API.Gateway.test/v1',
    '  https://gateway.test/v1  ',
  ];

  it.each(BASES)('agrees with the real adapter for %s', async (baseUrl) => {
    // The adapter trims and strips trailing slashes, so its request is the canonical form of
    // the same address; `modelsUrl` must land on the same string.
    expect(modelsUrl(baseUrl)).toBe(await adapterModelsUrl(baseUrl));
  });

  it('appends /v1 for a bare host and leaves an explicit path alone', () => {
    expect(modelsUrl('https://gateway.test')).toBe('https://gateway.test/v1/models');
    expect(modelsUrl('https://gateway.test/v1')).toBe('https://gateway.test/v1/models');
    expect(modelsUrl('https://gateway.test/openai/v1')).toBe(
      'https://gateway.test/openai/v1/models',
    );
  });
});

describe('listProviderModels', () => {
  it('reports the ids the endpoint answered with', async () => {
    const fake = wire(() => jsonResponse({ data: [{ id: 'a' }, { id: 'b' }] }));
    const result = await listProviderModels(
      { baseUrl: 'https://gw.test/v1', apiKey: KEY },
      {
        transport: fake.fetch,
      },
    );

    expect(result).toEqual({ kind: 'ok', models: ['a', 'b'] });
    expect(fake.urls).toEqual(['https://gw.test/v1/models']);
    // The key travels in the header and NOWHERE in the returned value (invariant 6).
    expect(fake.authorizations).toEqual([`Bearer ${KEY}`]);
    expect(JSON.stringify(result)).not.toContain(KEY);
  });

  it('accepts a bare array and the vendor’s `name` field, and does not repeat an id', async () => {
    const bare = wire(() => jsonResponse([{ id: 'a' }, { name: 'b' }]));
    await expect(
      listProviderModels({ baseUrl: 'https://gw.test/v1', apiKey: '' }, { transport: bare.fetch }),
    ).resolves.toEqual({ kind: 'ok', models: ['a', 'b'] });
    // An empty key means "send no Authorization header", which a local runtime requires.
    expect(bare.authorizations).toEqual([undefined]);

    const duplicates = wire(() => jsonResponse({ data: [{ id: 'a' }, { id: 'a' }, { id: 'b' }] }));
    await expect(
      listProviderModels(
        { baseUrl: 'https://gw.test/v1', apiKey: '' },
        {
          transport: duplicates.fetch,
        },
      ),
    ).resolves.toEqual({ kind: 'ok', models: ['a', 'b'] });
  });

  it('separates an empty list from an unreachable endpoint and from an HTTP error', async () => {
    const empty = wire(() => jsonResponse({ data: [] }));
    await expect(
      listProviderModels({ baseUrl: 'https://gw.test/v1', apiKey: '' }, { transport: empty.fetch }),
    ).resolves.toEqual({ kind: 'empty' });

    // A gateway that is not there: the transport rejects. The cause is never surfaced — a
    // rejection message can quote the request, and the request carries the key.
    const unreachable = wire(() => {
      throw new Error(`fetch failed for https://gw.test/v1/models with Bearer ${KEY}`);
    });
    await expect(
      listProviderModels(
        { baseUrl: 'https://gw.test/v1', apiKey: KEY },
        {
          transport: unreachable.fetch,
        },
      ),
    ).resolves.toEqual({ kind: 'unreachable' });

    // A 401 is a STATUS, not an invented model list: this is the case `listModels()` would
    // have answered with the vendor's well-known ids.
    const denied = wire(() => jsonResponse({ error: { message: 'nope' } }, 401));
    await expect(
      listProviderModels(
        { baseUrl: 'https://gw.test/v1', apiKey: KEY },
        { transport: denied.fetch },
      ),
    ).resolves.toEqual({ kind: 'http', status: 401 });
  });

  it('never invents a model id, and never returns the key', async () => {
    const malformed = wire(() => new Response('not json at all', { status: 200 }));
    // Passed through a VARIABLE so the extra `model` field is not an excess-property error: this
    // call needs the endpoint and the key, and a caller holding a whole configuration must be able
    // to hand it over without narrowing it first.
    const target = { baseUrl: 'https://gateway.test/v1', apiKey: KEY, model: MODEL };
    const result = await listProviderModels(target, { transport: malformed.fetch });
    expect(result).toEqual({ kind: 'unreachable' });
    expect(JSON.stringify(result)).not.toContain(KEY);
    expect(JSON.stringify(result)).not.toContain(MODEL);
  });

  it('asks nothing at all when the endpoint is empty', async () => {
    const fake = wire(() => jsonResponse({ data: [{ id: 'a' }] }));
    // A relative `/models` would hit the app's own origin, which the user never configured.
    await expect(
      listProviderModels({ baseUrl: '   ', apiKey: KEY }, { transport: fake.fetch }),
    ).resolves.toEqual({ kind: 'unreachable' });
    expect(fake.urls).toEqual([]);
  });

  it('reports each outcome as a different sentence', async () => {
    expect(modelListNote({ kind: 'ok', models: ['a', 'b'] })).toEqual({
      key: 'setup.modelsLoaded',
      params: { count: 2 },
    });
    expect(modelListNote({ kind: 'empty' })).toEqual({ key: 'setup.modelsEmpty' });
    expect(modelListNote({ kind: 'unreachable' })).toEqual({ key: 'setup.modelsUnreachable' });
    expect(modelListNote({ kind: 'http', status: 403 })).toEqual({
      key: 'setup.modelsHttpFailed',
      params: { status: 403 },
    });
  });
});

describe('a saved model that is no longer in the list', () => {
  it('is KEPT and flagged, never rewritten to something the endpoint listed', () => {
    const choices = modelChoices('retired-model', ['a', 'b']);

    // The decision: the saved string survives, and the screen is told it is missing so it can
    // say so. Rewriting it would relabel every past turn of every session that pinned it, and
    // `/models` is a convenience endpoint that omits ids a gateway still serves.
    expect(choices.savedModel).toBe('retired-model');
    expect(choices.ids).toEqual(['a', 'b']);
    expect(choices.ids).not.toContain('retired-model');
  });

  it('is not flagged when the endpoint does list it, and an empty saved value is not flagged', () => {
    expect(modelChoices('a', ['a', 'b']).savedModel).toBeUndefined();
    expect(modelChoices('', ['a', 'b']).savedModel).toBeUndefined();
    // Whitespace is not a model id: a field that looks empty must not raise a warning.
    expect(modelChoices('   ', ['a', 'b']).savedModel).toBeUndefined();
  });

  it('does not depend on the fetch answering at all: the flag is a comparison, not a request', async () => {
    const fake = wire(() => jsonResponse({ data: [{ id: 'a' }] }));
    const result: ModelListResult = await listProviderModels(
      { baseUrl: 'https://gw.test/v1', apiKey: '' },
      { transport: fake.fetch },
    );
    if (result.kind !== 'ok') throw new Error('the fake answered with a list');
    const choices = modelChoices('retired-model', result.models);
    // The endpoint's answer contains only what it said; "retired-model" is kept from the ROW,
    // never spliced into the list.
    expect(result.models).toEqual(['a']);
    expect(choices.savedModel).toBe('retired-model');
  });
});

describe('a long list', () => {
  it('offers a bounded number of options and reports both counts', () => {
    const models = Array.from({ length: MODEL_OPTION_LIMIT + 25 }, (_, index) => `m-${index}`);
    const choices = modelChoices('', models);

    // The cap keeps the control usable; `total` is what lets the screen say how many were not
    // shown, and the model field stays a free-text input so nothing becomes unreachable.
    expect(choices.ids).toHaveLength(MODEL_OPTION_LIMIT);
    expect(choices.total).toBe(MODEL_OPTION_LIMIT + 25);
    expect(choices.ids[0]).toBe('m-0');
    expect(choices.ids.at(-1)).toBe(`m-${MODEL_OPTION_LIMIT - 1}`);
    // The list is NOT sorted or reordered: the endpoint's own order is a signal (newest or
    // most-recommended first for several vendors), and rewriting it would be a second opinion.
    expect([...choices.ids]).toEqual(models.slice(0, MODEL_OPTION_LIMIT));
  });

  it('caps a flagged saved model out of the option list without losing the flag', () => {
    const models = Array.from({ length: MODEL_OPTION_LIMIT + 5 }, (_, index) => `m-${index}`);
    const choices = modelChoices('retired-model', models);
    expect(choices.savedModel).toBe('retired-model');
    expect(choices.ids).toHaveLength(MODEL_OPTION_LIMIT);
  });
});
