import test from 'node:test';
import assert from 'node:assert/strict';
import {buildWorldContentGroups} from './world-content-groups.mjs';

const prefix='atlas/fantasy/globe/';
const files=['realm-texture.png','native-ocean-depth.rgba','generated/heartlands-detail.png','generated/aurora-detail.png','generated/aurora-detail-mask.png'].map(path=>({path:prefix+path}));
test('overview excludes optional detail and island masks cannot activate independently',()=>{
  const result=buildWorldContentGroups(files,[{id:'heartlands'}],[{id:'aurora'}]);
  assert.deepEqual(result.overview.files,files.slice(0,2).map(file=>file.path));
  assert.deepEqual(result.chains[0].files,files.slice(3).map(file=>file.path));
  assert.deepEqual([result.overview,...result.regions,...result.chains].flatMap(group=>group.files).sort(),files.map(file=>file.path).sort());
});
test('incomplete pairs, overlap and unsafe source IDs fail export',()=>{
  assert.throws(()=>buildWorldContentGroups(files.slice(0,-1),[],[{id:'aurora'}]),/Missing/);
  assert.throws(()=>buildWorldContentGroups(files,[{id:'heartlands'},{id:'heartlands'}],[]),/overlapping/);
  assert.throws(()=>buildWorldContentGroups(files,[],[{id:'../aurora'}]),/Invalid/);
});
