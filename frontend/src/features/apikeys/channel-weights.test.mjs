import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import ts from 'typescript';

const srcRoot = join(import.meta.dirname, '..', '..');

function read(relativePath) {
  return readFileSync(join(srcRoot, relativePath), 'utf8');
}

const channelWeightsSource = read('features/apikeys/utils/channel-weights.ts');
const transpiledChannelWeights = ts.transpileModule(channelWeightsSource, {
  compilerOptions: {
    module: ts.ModuleKind.ESNext,
    target: ts.ScriptTarget.ES2023,
  },
}).outputText;
const channelWeightsModuleUrl = `data:text/javascript;base64,${Buffer.from(transpiledChannelWeights).toString('base64')}`;
const { validateChannelWeights } = await import(channelWeightsModuleUrl);

// The backend only enforces these rules while the mode is on: the channel lists
// are preserved when it is toggled off, so a disabled profile may hold stale or
// previously invalid entries without blocking the save.

test('independent channel weights are not validated while the mode is off', () => {
  const dirty = [{ channelID: 0, weight: -1 }];

  assert.equal(validateChannelWeights(false, dirty), null);
  assert.equal(validateChannelWeights(null, dirty), null);
  assert.equal(validateChannelWeights(undefined, dirty), null);
});

test('an enabled profile without channel weights is rejected', () => {
  assert.deepEqual(validateChannelWeights(true, []), { issue: 'empty' });
  assert.deepEqual(validateChannelWeights(true, null), { issue: 'empty' });
  assert.deepEqual(validateChannelWeights(true, undefined), { issue: 'empty' });
});

test('channel ids must be positive integers', () => {
  assert.deepEqual(validateChannelWeights(true, [{ channelID: 0, weight: 10 }]), { issue: 'invalidChannel', index: 0 });
  assert.deepEqual(validateChannelWeights(true, [{ channelID: 1.5, weight: 10 }]), { issue: 'invalidChannel', index: 0 });
  assert.deepEqual(validateChannelWeights(true, [{ channelID: 1, weight: 10 }, { channelID: 0, weight: 10 }]), {
    issue: 'invalidChannel',
    index: 1,
  });
});

test('weights must be integers between 0 and 100', () => {
  for (const weight of [-1, 101, 12.5]) {
    assert.deepEqual(validateChannelWeights(true, [{ channelID: 1, weight }]), { issue: 'invalidWeight', index: 0 });
  }

  assert.deepEqual(validateChannelWeights(true, [{ channelID: 1, weight: 10 }, { channelID: 2, weight: 101 }]), {
    issue: 'invalidWeight',
    index: 1,
  });
});

test('a channel can only be added once', () => {
  const weights = [
    { channelID: 1, weight: 100 },
    { channelID: 2, weight: 50 },
    { channelID: 1, weight: 10 },
  ];

  assert.deepEqual(validateChannelWeights(true, weights), { issue: 'duplicate', index: 2 });
});

test('a well formed independent channel weight list passes', () => {
  assert.equal(
    validateChannelWeights(true, [
      { channelID: 1, weight: 100 },
      { channelID: 2, weight: 0 },
    ]),
    null
  );
});

// zod strips keys that are not declared by a schema, so every schema and query
// that touches a profile has to carry the new fields or saving silently turns
// the mode off. These source assertions fail when a future profile shape is
// added without them.

test('every GraphQL profile selection carries the independent channel weight fields', () => {
  const source = read('features/apikeys/data/apikeys.ts');
  const modelIDs = source.match(/modelIDs/g)?.length ?? 0;
  const independentChannelWeights = source.match(/independentChannelWeights/g)?.length ?? 0;
  const channelWeights = source.match(/channelWeights \{/g)?.length ?? 0;

  assert.ok(modelIDs > 0, 'expected at least one profile selection');
  assert.equal(independentChannelWeights, modelIDs);
  assert.equal(channelWeights, modelIDs);
});

test('every profile zod schema declares the independent channel weight fields', () => {
  const source = read('features/apikeys/data/schema.ts');
  const modelIDs = source.match(/modelIDs:/g)?.length ?? 0;
  const independentChannelWeights = source.match(/independentChannelWeights:/g)?.length ?? 0;
  const channelWeights = source.match(/channelWeights:/g)?.length ?? 0;

  assert.equal(modelIDs, 4);
  assert.equal(independentChannelWeights, modelIDs);
  assert.equal(channelWeights, modelIDs);
});

test('the template form schema declares and validates the independent channel weights', () => {
  const source = read('features/apikeys/data/template-form-schema.ts');

  assert.match(source, /independentChannelWeights: z\.boolean\(\)\.optional\(\)\.nullable\(\)/);
  assert.match(source, /channelWeights: z\.array\(profileChannelWeightSchema\)\.optional\(\)\.nullable\(\)/);
  assert.match(source, /validateChannelWeights\(data\.profile\?\.independentChannelWeights, data\.profile\?\.channelWeights\)/);
});

test('the edit template dialog seeds the independent channel weights from the template', () => {
  const source = read('features/apikeys/components/apikeys-edit-template-dialog.tsx');

  assert.match(source, /independentChannelWeights: profile\?\.independentChannelWeights \?\? false/);
  assert.match(source, /channelWeights: profile\?\.channelWeights\?\.map\(/);
});

test('channel weight validation messages are localized in English and Chinese', () => {
  const en = JSON.parse(read('locales/en/apikeys.json'));
  const zh = JSON.parse(read('locales/zh-CN/apikeys.json'));

  for (const issue of ['empty', 'duplicate', 'invalidChannel', 'invalidWeight']) {
    const key = `apikeys.validation.channelWeights.${issue}`;

    assert.ok(en[key], `missing key in locales/en/apikeys.json: ${key}`);
    assert.ok(zh[key], `missing key in locales/zh-CN/apikeys.json: ${key}`);
  }
});
