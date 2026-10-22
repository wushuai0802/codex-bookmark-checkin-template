import test from 'node:test';
import assert from 'node:assert/strict';
import {classifySiteMigration,providerLoginPage} from '../src/site-migration.mjs';
import {processTarget} from '../src/browser.mjs';

const origin='https://old.example',base={url:origin+'/',allowedOrigins:[origin]};
test('dedicated migration pages stop with a fixed diagnosis and no submission',()=>{
  for(const page of [{title:'本站已迁移',bodyText:'前往新的地址'},
    {title:'公告',bodyText:'本站已经迁移到新域名，请前往新地址，稍后自动跳转'}]){
    const result=classifySiteMigration({...base,...page});
    assert.equal(result.failureCode,'site_migration');assert.equal(result.retryable,false);assert.equal(result.submissionAttempted,false);
    assert.doesNotMatch(JSON.stringify(result),/destination|new-domain/);
  }
});
test('historical notices, ordinary failures and internal browser error pages are not migration',()=>{
  for(const page of [{title:'首页',bodyText:'欢迎回来。历史公告：本站已迁移到新域名。今日签到'},
    {title:'登录',bodyText:'请登录，本站已迁移的旧公告'}, {url:'about:blank'}, {url:'chrome-error://chromewebdata/'}])
    assert.equal(classifySiteMigration({...base,...page}),null);
});
test('unknown redirect origins require bookmark review while known OAuth login pages retain login recovery',()=>{
  const changed=classifySiteMigration({...base,url:'https://new.example/'});
  assert.equal(changed.failureCode,'bookmark_origin_changed');
  assert.equal(classifySiteMigration({...base,url:'https://new.example/',allowedOrigins:[origin,'https://new.example']}),null);
  for(const url of ['https://connect.linux.do/oauth2/authorize?state=example','https://github.com/login/oauth/authorize','https://accounts.google.com/v3/signin/identifier']){
    assert.equal(providerLoginPage(url),true);assert.equal(classifySiteMigration({...base,url}),null);
  }
  assert.equal(providerLoginPage('https://github.com/some-repository'),false);
  assert.equal(classifySiteMigration({...base,url:'http://old.example/'}).failureCode,'bookmark_origin_changed');
});
test('a migration result never proceeds to another candidate or retry round',async()=>{
  let calls=0;
  const page={url:()=>origin+'/',close:async()=>{}};
  const result=await processTarget({newPage:async()=>page},{origin,candidates:[origin+'/',origin+'/attendance.php'],allowedOrigins:[origin]},
    {retryCount:3,retryDelayMs:0,failureScreenshots:false},{},'unused',{runCandidate:async()=>{
      calls++;return classifySiteMigration({...base,title:'本站已迁移'});
    }});
  assert.equal(result.failureCode,'site_migration');assert.equal(calls,1);
});
