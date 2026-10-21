'use strict';
const { databaseConstructor } = require('../../src/sqlite/driver');
function makeDatabase(file, tasks, { indexed = false } = {}) {
  const db = new (databaseConstructor())(file);
  try {
    db.pragma('journal_mode = WAL'); db.pragma('synchronous = NORMAL');
    db.exec('CREATE TABLE shell_records(kind TEXT NOT NULL,id TEXT NOT NULL,body TEXT NOT NULL,PRIMARY KEY(kind,id))');
    if (indexed) db.exec('CREATE INDEX experiment_kind_rowid ON shell_records(kind)');
    const stmt = db.prepare("INSERT INTO shell_records VALUES ('task',?,?)");
    db.transaction(() => { for (const t of tasks) stmt.run(t.id, JSON.stringify(t)); })();
  } finally { db.close(); }
}
module.exports = { makeDatabase };
