import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import * as shared from '../supabase/functions/_shared/leagueEngine.mjs';
const require=createRequire(import.meta.url);
const {parse}=require('@babel/parser');
const source=execFileSync('git',['show','HEAD:src/App.jsx'],{encoding:'utf8'});
const names=Object.keys(shared);
const nodes=parse(source,{sourceType:'module',plugins:['jsx']}).program.body.filter(n=>(n.type==='FunctionDeclaration'&&names.includes(n.id.name))||(n.type==='VariableDeclaration'&&n.declarations[0].id.name==='CONFIG'));
const legacy=Function(nodes.map(n=>source.slice(n.start,n.end)).join('\n')+';return {replayGames,computePlacements};')();
for(const preference of ['ATK','DEF','FLEX']) test('shared replay preserves committed outcomes: '+preference,()=>{
 const players=['a','b','c','d'].map(id=>({id,name:id,preferredRole:preference,mmr:1000,pts:0}));
 const games=Array.from({length:12},(_,i)=>({id:'g'+i,date:new Date(Date.UTC(2026,8,i+1,12)).toISOString(),sideA:['a','b'],sideB:['c','d'],scoreA:i%2?4:10,scoreB:i%2?10:6,winner:i%2?'B':'A',roles:{a:'ATK',b:'DEF',c:i%3?'ATK':'FLEX',d:i%3?'DEF':'FLEX'},penalties:i===6?{a:{yellow:1,red:0}}:{}}));
 const seasons=[{id:'season',startAt:'2026-09-01T00:00:00Z'}];
 assert.deepEqual(shared.replayGames(players,games,seasons[0].startAt,seasons),legacy.replayGames(players,games,seasons[0].startAt,seasons));
 assert.deepEqual(shared.computePlacements(games,seasons),legacy.computePlacements(games,seasons));
});
