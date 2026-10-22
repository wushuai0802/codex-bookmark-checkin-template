import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeAppearance} from '../public/appearance.mjs';
import {displacementField} from '../public/glass-geometry.mjs';

test('appearance accepts only known modes and bounds local preference values',()=>{
  assert.deepEqual(normalizeAppearance({mode:'injected',cards:false,motion:false,refraction:999,transparency:-8}),
    {mode:'ultra',cards:false,motion:false,refraction:100,transparency:0});
  assert.equal(normalizeAppearance({mode:'none'}).mode,'none');
  assert.equal(normalizeAppearance({mode:'standard',refraction:'bad'}).refraction,70);
  assert.equal(normalizeAppearance(null).mode,'ultra');
});
test('lens field is neutral at the center and samples inward at opposite edges',()=>{
  const map=displacementField(120,80,20,18),pixel=(x,y)=>map.data.slice((y*map.width+x)*4,(y*map.width+x)*4+4);
  assert.deepEqual([...pixel(60,40)],[128,128,0,255]);
  assert.ok(pixel(2,40)[0]>128);assert.ok(pixel(117,40)[0]<128);
  assert.ok(pixel(60,2)[1]>128);assert.ok(pixel(60,77)[1]<128);
  assert.ok(pixel(2,40)[2]>0,'bevel mask must be nonzero near the rim');
});
test('large lenses use a bounded map without changing target geometry',()=>{
  const map=displacementField(2400,1600,24);
  assert.equal(map.width,640);assert.ok(map.height<=640);
  assert.equal(map.data.length,map.width*map.height*4);
});
