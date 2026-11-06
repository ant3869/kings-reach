// Issue #1: memory keyword recall must not break on punctuation or FTS5 operator words.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { ftsMatchQuery } from '../dist/memory.js';

// The same table shape as src/db.ts, in memory: real FTS5, not a mock.
function fixture() {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE memories (id INTEGER PRIMARY KEY, summary TEXT, raw_text TEXT);
    CREATE VIRTUAL TABLE memories_fts USING fts5(summary, raw_text, content=memories, content_rowid=id);`);
  const add = db.prepare('INSERT INTO memories (summary, raw_text) VALUES (?, ?)');
  const ftsAdd = db.prepare('INSERT INTO memories_fts (rowid, summary, raw_text) VALUES (?, ?, ?)');
  for (const [i, text] of ['the status of the deploy is green', 'check the e-mail settings', 'NOT a drill, deploy near the end'].entries()) {
    add.run(text, text); ftsAdd.run(i + 1, text, text);
  }
  const search = (q) => db.prepare('SELECT rowid FROM memories_fts WHERE memories_fts MATCH ?').all(q).map((r) => r.rowid);
  return { db, search };
}

test('the old query shape really did fail on ordinary questions (guards the test itself)', () => {
  const { search } = fixture();
  const old = (t) => t.replace(/["*:()]/g, ' ').split(/\s+/).filter((w) => w.length > 2).slice(0, 8).join(' OR ');
  for (const msg of ["what's the status?", 'check my e-mail', 'NOT sure about this']) assert.throws(() => search(old(msg)), /fts5|syntax|no such column/i, msg);
});

test('punctuation, apostrophes and hyphens no longer break the query, and still find the memory', () => {
  const { search } = fixture();
  // Words are OR-ed (as before), so common words like "the" also match other rows: assert the right one is found.
  assert.ok(search(ftsMatchQuery("what's the status?")).includes(1));
  assert.deepEqual(search(ftsMatchQuery('check my e-mail')), [2]);
  assert.deepEqual(search(ftsMatchQuery('status?')), [1]);
});

test('operator words and FTS syntax are matched as plain words, never parsed', () => {
  const { search } = fixture();
  for (const msg of ['NOT', 'AND OR NEAR', 'deploy NOT drill', 'status* "quoted" (paren) col:umn ^start', '-minus +plus {brace} [bracket]']) {
    assert.doesNotThrow(() => search(ftsMatchQuery(msg) || '"zzz"'), msg);
  }
  assert.ok(search(ftsMatchQuery('NOT a drill')).includes(3), 'the word NOT is searched for, not obeyed');
});

test('shape: quoted words joined by OR, max 8, short words dropped, unicode kept, nothing searchable gives empty', () => {
  assert.equal(ftsMatchQuery("what's up"), '"what"');
  assert.equal(ftsMatchQuery('alpha beta gamma'), '"alpha" OR "beta" OR "gamma"');
  assert.equal(ftsMatchQuery('one two three four five six seven eight nine ten').split(' OR ').length, 8);
  assert.equal(ftsMatchQuery('café déjà vu'), '"café" OR "déjà"');
  assert.equal(ftsMatchQuery('?! .. a b'), '');
  assert.equal(ftsMatchQuery(''), '');
});

test('a double quote in the input cannot escape the quoting', () => {
  const { search } = fixture();
  const q = ftsMatchQuery('x" OR "deploy status"); DROP TABLE memories; --');
  assert.ok(!q.includes('""'));
  assert.doesNotThrow(() => search(q));
});
