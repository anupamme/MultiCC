#!/usr/bin/env node
'use strict';
// Same schema, prepared statements, transactions and WAL policy on isolated data.
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const assert = require('node:assert/strict');
const { performance } = require('node:perf_hooks');
const Rust = require('../src/sqlite/driver').CompatDatabase;
const Node = require('../src/sqlite/node-driver').CompatDatabase;
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-sqlite-bench-'));
const entries = [], counts = [100, 3000], rounds = 15;
const median = values => [...values].sort((a,b)=>a-b)[Math.floor(values.length/2)];
const round = value => Math.round(value*10000)/10000;
const databases=[];
try {
  for (const count of counts) {
    const rows = Array.from({length:count}, (_,i)=>[String(i),JSON.stringify({title:`任务 ${i}`,content:'x'.repeat(8192)})]);
    const engines = Object.fromEntries([['node',Node],['rust',Rust]].map(([name,Database])=>{
      const db=new Database(path.join(root,`${name}-${count}.sqlite`)); databases.push(db);
      db.pragma('journal_mode=WAL');db.pragma('synchronous=NORMAL');
      db.exec('CREATE TABLE t(id TEXT PRIMARY KEY,body TEXT NOT NULL)');
      const insert=db.prepare('INSERT INTO t VALUES(?,?)');
      db.transaction(()=>{for(const row of rows)insert.run(...row);}).immediate();
      const lookup=db.prepare('SELECT body FROM t WHERE id=?'),all=db.prepare('SELECT id,body FROM t ORDER BY rowid');
      const update=db.prepare('UPDATE t SET body=? WHERE id=?');
      const write=()=>{for(let i=0;i<100;i++)update.run(rows[i%count][1],rows[i%count][0]);};
      const alternatives=rows.map(([id,body])=>[id,body.replace('任务', '变更')]);
      let revision=0;
      const changedWrite=()=>{
        const selected=++revision%2?alternatives:rows;
        for(let i=0;i<100;i++)update.run(selected[i%count][1],selected[i%count][0]);
      };
      return [name,{db,operations:{
        readAll:()=>assert.equal(all.all().length,count),
        indexedRead1000:()=>{for(let i=0;i<1000;i++)assert.equal(lookup.get(String(i%count)).body,rows[i%count][1]);},
        unchangedUpdate100:db.transaction(write).immediate,
        write100Transaction:db.transaction(changedWrite).immediate,
      }}];
    }));
    const version=Object.fromEntries(Object.entries(engines).map(([name,{db}])=>[name,db.prepare('SELECT sqlite_version() AS v').get().v]));
    for(const operation of Object.keys(engines.node.operations)) {
      const timings={node:[],rust:[]};
      for(let pass=-2;pass<rounds;pass++)for(const name of pass%2?['rust','node']:['node','rust']) {
        const start=performance.now();engines[name].operations[operation]();
        if(pass>=0)timings[name].push(performance.now()-start);
      }
      const nodeMs=median(timings.node),rustMs=median(timings.rust);
      entries.push({count,operation,nodeMs:round(nodeMs),rustMs:round(rustMs),speedup:round(nodeMs/rustMs),sqlite:version});
    }
  }
  console.log(JSON.stringify({runtime:process.version,platform:process.platform,arch:process.arch,cpu:os.cpus()[0].model,
    rounds,bytesPerBody:8192,notes:'合成数据、热文件缓存、相同事务与WAL策略；包含Node/Rust调用开销，不代表异步读模型收益。',entries},null,2));
} finally { for(const db of databases)db.close();fs.rmSync(root,{recursive:true,force:true}); }
