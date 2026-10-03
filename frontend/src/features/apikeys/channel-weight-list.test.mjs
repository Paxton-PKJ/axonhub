import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import ts from 'typescript';

const srcRoot = join(import.meta.dirname, '..', '..');

function read(relativePath) {
  return readFileSync(join(srcRoot, relativePath), 'utf8');
}

function toDataUrl(source) {
  const transpiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2023,
    },
  }).outputText;

  return { transpiled, url: `data:text/javascript;base64,${Buffer.from(transpiled).toString('base64')}` };
}

// channel-weight-list.ts imports ../../channels/utils/ordering-weight by relative path, which a
// data URL cannot resolve, so the dependency is transpiled first and its specifier rewritten.
const orderingWeights = toDataUrl(read('features/channels/utils/ordering-weight.ts'));
const channelWeightList = toDataUrl(read('features/apikeys/utils/channel-weight-list.ts'));
const rewrittenSource = channelWeightList.transpiled.replace(
  "'../../channels/utils/ordering-weight'",
  `'${orderingWeights.url}'`
);
assert.notEqual(rewrittenSource, channelWeightList.transpiled, 'the ordering-weight import must be rewritten');
const channelWeightListUrl = `data:text/javascript;base64,${Buffer.from(rewrittenSource).toString('base64')}`;

const { calculateRelativeWeight } = await import(orderingWeights.url);
const {
  sortChannelWeights,
  moveChannelWeight,
  setChannelWeight,
  addChannelWeight,
  removeChannelWeight,
  seedChannelWeights,
} = await import(channelWeightListUrl);

test('sortChannelWeights orders by weight descending without touching the input', () => {
  const list = [
    { channelID: 1, weight: 10 },
    { channelID: 2, weight: 90 },
    { channelID: 3, weight: 50 },
  ];
  const snapshot = structuredClone(list);

  assert.deepEqual(sortChannelWeights(list), [
    { channelID: 2, weight: 90 },
    { channelID: 3, weight: 50 },
    { channelID: 1, weight: 10 },
  ]);
  assert.deepEqual(list, snapshot);
});

test('sortChannelWeights keeps the relative order of equal weights', () => {
  const list = [
    { channelID: 7, weight: 40 },
    { channelID: 8, weight: 40 },
    { channelID: 9, weight: 90 },
  ];

  assert.deepEqual(
    sortChannelWeights(list).map((item) => item.channelID),
    [9, 7, 8]
  );
});

test('moveChannelWeight recomputes the moved weight from its new neighbours at the top', () => {
  const list = [
    { channelID: 1, weight: 100 },
    { channelID: 2, weight: 50 },
    { channelID: 3, weight: 20 },
  ];
  const snapshot = structuredClone(list);

  const moved = moveChannelWeight(list, 2, 0);

  assert.deepEqual(
    moved.map((item) => item.channelID),
    [3, 1, 2]
  );
  assert.equal(moved[0].weight, calculateRelativeWeight(undefined, 100));
  assert.equal(moved[1].weight, 100);
  assert.equal(moved[2].weight, 50);
  assert.deepEqual(list, snapshot);
});

test('moveChannelWeight splits the gap between the new neighbours', () => {
  const list = [
    { channelID: 1, weight: 100 },
    { channelID: 2, weight: 50 },
    { channelID: 3, weight: 20 },
  ];

  const moved = moveChannelWeight(list, 0, 1);

  assert.deepEqual(
    moved.map((item) => item.channelID),
    [2, 1, 3]
  );
  assert.equal(moved[1].weight, calculateRelativeWeight(50, 20));
  assert.equal(moved[0].weight, 50);
  assert.equal(moved[2].weight, 20);
});

test('moveChannelWeight ignores a no-op move', () => {
  const list = [
    { channelID: 1, weight: 100 },
    { channelID: 2, weight: 50 },
  ];

  assert.deepEqual(moveChannelWeight(list, 1, 1), list);
});

test('setChannelWeight clamps the value and re-sorts', () => {
  const list = [
    { channelID: 1, weight: 10 },
    { channelID: 2, weight: 50 },
  ];
  const snapshot = structuredClone(list);

  assert.deepEqual(setChannelWeight(list, 1, 101), [
    { channelID: 1, weight: 100 },
    { channelID: 2, weight: 50 },
  ]);
  assert.deepEqual(setChannelWeight(list, 2, -5), [
    { channelID: 1, weight: 10 },
    { channelID: 2, weight: 0 },
  ]);
  assert.deepEqual(list, snapshot);
});

test('addChannelWeight appends with the default weight and sorts', () => {
  const list = [
    { channelID: 1, weight: 10 },
    { channelID: 2, weight: 50 },
  ];

  assert.deepEqual(addChannelWeight(list, 3, 80), [
    { channelID: 3, weight: 80 },
    { channelID: 2, weight: 50 },
    { channelID: 1, weight: 10 },
  ]);
  assert.deepEqual(addChannelWeight(list, 3, 500), [
    { channelID: 3, weight: 100 },
    { channelID: 2, weight: 50 },
    { channelID: 1, weight: 10 },
  ]);
  assert.deepEqual(addChannelWeight(list, 2, 90), list);
  assert.deepEqual(list, [
    { channelID: 1, weight: 10 },
    { channelID: 2, weight: 50 },
  ]);
});

test('removeChannelWeight drops the given channel', () => {
  const list = [
    { channelID: 1, weight: 10 },
    { channelID: 2, weight: 50 },
  ];

  assert.deepEqual(removeChannelWeight(list, 1), [{ channelID: 2, weight: 50 }]);
  assert.deepEqual(removeChannelWeight(list, 99), list);
  assert.deepEqual(list, [
    { channelID: 1, weight: 10 },
    { channelID: 2, weight: 50 },
  ]);
});

test('seedChannelWeights uses global weights, defaults unknown channels to 0 and sorts', () => {
  const globalWeights = new Map([
    [1, 30],
    [2, 70],
  ]);

  assert.deepEqual(
    seedChannelWeights([1, 2, 3], (id) => globalWeights.get(id)),
    [
      { channelID: 2, weight: 70 },
      { channelID: 1, weight: 30 },
      { channelID: 3, weight: 0 },
    ]
  );
});

// zod strips undeclared keys and the switch hides the legacy sections, so a form that
// forgot the editor would silently submit the mode with an uneditable empty list.

const apikeyDialogs = [
  'features/apikeys/components/apikeys-profiles-dialog.tsx',
  'features/apikeys/components/apikeys-create-template-dialog.tsx',
  'features/apikeys/components/apikeys-edit-template-dialog.tsx',
];

test('every profile form renders the channel weights editor behind the switch', () => {
  for (const dialog of apikeyDialogs) {
    const source = read(dialog);

    assert.match(source, /import \{ firstChannelWeightsError, ProfileChannelWeightsEditor \} from '\.\/profile-channel-weights-editor'/);
    assert.match(source, /<ProfileChannelWeightsEditor/);
    assert.match(source, /name=\{?['`]?(?:profiles\.\$\{profileIndex\}|profile)\.independentChannelWeights['`]/);
    assert.match(source, /<Switch checked=\{field\.value === true\} onCheckedChange=\{handleToggleIndependentChannelWeights\} \/>/);
    assert.match(source, /channels={channelSummaries}/);
  }
});

test('the allowed channels and channel tags sections are hidden while the mode is on', () => {
  for (const dialog of apikeyDialogs) {
    const source = read(dialog);
    const hiddenBranchStart = source.indexOf('{!independentChannelWeights && (');
    const editorBranchStart = source.indexOf('{independentChannelWeights && (');

    assert.ok(hiddenBranchStart !== -1, `${dialog} must hide the legacy sections behind the switch`);
    assert.ok(editorBranchStart > hiddenBranchStart, `${dialog} must render the editor when the mode is on`);

    // Both legacy sections live inside the negated branch, and only there.
    assert.equal(source.match(/\{!independentChannelWeights && \(/g)?.length, 1);

    const hiddenBranch = source.slice(hiddenBranchStart, editorBranchStart);
    assert.match(hiddenBranch, /apikeys\.profiles\.allowedChannels'/);
    assert.match(hiddenBranch, /apikeys\.profiles\.allowedChannelTagsMatchMode'/);
    assert.match(hiddenBranch, /name=\{?['`]?(?:profiles\.\$\{profileIndex\}|profile)\.channelTags['`]/);
  }
});

test('the editor portals its channel picker into the dialog', () => {
  const editor = read('features/apikeys/components/profile-channel-weights-editor.tsx');

  assert.match(editor, /<AutoCompleteSelect[\s\S]*?portalContainer={portalContainer}/);
  assert.match(editor, /onChange\(moveChannelWeight\(/);
  assert.match(editor, /onChange\(addChannelWeight\(/);
  assert.match(editor, /onChange\(removeChannelWeight\(/);
  assert.match(editor, /onChange\(setChannelWeight\(/);
  assert.match(editor, /apikeys\.profiles\.channelWeights\.invalidWeight/);
  assert.match(editor, /apikeys\.profiles\.channelWeights\.unknownChannel/);
});

test('the bulk ordering dialog reuses the shared helpers instead of local copies', () => {
  const source = read('features/channels/components/channels-bulk-ordering-dialog.tsx');

  assert.doesNotMatch(source, /const calculateRelativeWeight =/);
  assert.doesNotMatch(source, /const clampWeight =/);
  assert.match(source, /import \{[\s\S]*?calculateRelativeWeight,[\s\S]*?clampOrderingWeight,[\s\S]*?\} from '\.\.\/utils\/ordering-weight';/);
});

test('the channel weights UI is localized in English and Chinese', () => {
  const en = JSON.parse(read('locales/en/apikeys.json'));
  const zh = JSON.parse(read('locales/zh-CN/apikeys.json'));
  const keys = [
    'apikeys.profiles.independentChannelWeights',
    'apikeys.profiles.independentChannelWeightsDescription',
    'apikeys.profiles.channelWeights',
    'apikeys.profiles.channelWeightsDescription',
    'apikeys.profiles.channelWeights.weight',
    'apikeys.profiles.channelWeights.add',
    'apikeys.profiles.channelWeights.empty',
    'apikeys.profiles.channelWeights.noMoreChannels',
    'apikeys.profiles.channelWeights.unknownChannel',
    'apikeys.profiles.channelWeights.invalidWeight',
    'apikeys.profiles.channelWeights.remove',
  ];

  for (const key of keys) {
    assert.ok(en[key], `missing key in locales/en/apikeys.json: ${key}`);
    assert.ok(zh[key], `missing key in locales/zh-CN/apikeys.json: ${key}`);
  }
});
