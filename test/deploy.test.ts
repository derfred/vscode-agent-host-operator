// The jsonnet library's version is the release's. (Whether deploy/*.yaml
// match the library is `npm run render -- --check`, which needs jsonnet.)

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

const json = (path: string) => JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8'));

describe('deploy/jsonnet', () => {
  it('carries package.json’s version, which names its default image', () => {
    assert.equal(json('../deploy/jsonnet/version.json').version, json('../package.json').version);
  });
});
