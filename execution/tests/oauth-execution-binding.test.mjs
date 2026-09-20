import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs/promises';
import { configForOAuthExecutionAccount } from '../src/oauth-execution-binding.mjs';
import { configForOAuthRecoveryAccount } from '../src/oauth-recovery-profile.mjs';
import { accountMetadataForOrigin } from '../src/result-identity.mjs';

const root = path.resolve('fixture'), origin = 'https://target.example';
const base = () => ({ automationUserDataDir: 'data/default', automaticOAuthProviders: { [origin]: 'LinuxDO' }, oauthExecutionAccountBindings: { [origin]: 'primary' }, oauthRecoveryAccountBindings: { [origin]: 'primary' }, oauthAccountIdentities: { 'https://other.example': { accountKey: 'primary', accountId: '1', provider: 'LinuxDO', upstreamProvider: 'Google', automationUserDataDir: 'data/accounts/primary' } } });
test('normal execution and recovery use the same explicitly confirmed upstream profile', () => {
  const config = base();
  const normal = configForOAuthExecutionAccount(config, root, origin);
  const recovery = configForOAuthRecoveryAccount(config, root, origin, 'LinuxDO');
  assert.equal(normal.automationUserDataDir, path.join(root, 'data/accounts/primary'));
  assert.equal(recovery.automationUserDataDir, normal.automationUserDataDir);
  assert.equal(config.automationUserDataDir, 'data/default');
  assert.equal(configForOAuthExecutionAccount(config, root, 'https://unbound.example'), config);
});
test('conflicting, missing, foreign-provider and out-of-tree account bindings fail closed', () => {
  for (const mutate of [
    c => { c.oauthRecoveryAccountBindings[origin] = 'secondary'; },
    c => { c.oauthSiteSessionBindings = { [origin]: 'shared' }; },
    c => { c.isolatedOAuthSiteProfiles = { [origin]: 'data/sites/other' }; },
    c => { c.oauthExecutionAccountBindings[origin] = 'missing'; },
    c => { c.automaticOAuthProviders[origin] = 'GitHub'; },
    c => { c.oauthAccountIdentities['https://other.example'].automationUserDataDir = '../outside'; }
  ]) { const c = base(); mutate(c); assert.throws(() => configForOAuthExecutionAccount(c, root, origin)); }
});
test('the execution fingerprint changes with upstream identity and preflight honors binding', async () => {
  const c = base(); const before = accountMetadataForOrigin(origin, c).executionBinding;
  c.oauthAccountIdentities['https://other.example'].accountId = '2';
  assert.notEqual(before, accountMetadataForOrigin(origin, c).executionBinding);
  const ps = await fs.readFile(new URL('../scripts/Prepare-NativeWafSession.ps1', import.meta.url), 'utf8');
  assert.match(ps, /oauthExecutionAccountBindings/);
  assert.match(ps, /Resolve-OAuthAccountConfiguration/);
  const index = await fs.readFile(new URL('../src/index.mjs', import.meta.url), 'utf8');
  assert.equal(index.split('releaseBoundAccountContext(account)').length - 1, 2);
  assert.match(index, /identityBoundMethods/);
  assert.match(index, /methods.filter\(method => \["oauth", "native_oauth"\]/);
});
