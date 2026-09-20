import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

test('all published schemas are valid JSON with stable IDs', () => {
  const directory = path.resolve('schemas');
  const files = fs.readdirSync(directory).filter((file) => file.endsWith('.schema.json')).sort();
  assert.ok(files.length >= 7);
  for (const file of files) {
    const schema = JSON.parse(fs.readFileSync(path.join(directory, file), 'utf8'));
    assert.equal(schema.$schema, 'https://json-schema.org/draft/2020-12/schema');
    assert.match(schema.$id, /^https:\/\/example\.invalid\/codex-checkin-fabric-v2\/.+\.schema\.json$/);
    assert.equal(schema.type, 'object');
  }
});
