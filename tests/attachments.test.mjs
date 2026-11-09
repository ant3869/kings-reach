// Files attached to a chat message: storing them, finding them by id, what the agent is told, and what that does to routing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { attachmentBlock, hasAttachments, withoutAttachments } from '../dist/attach-format.js';
import { displayName, MAX_FILE_BYTES, MAX_FILES, removeUpload, resolveAttachments, storeUpload, UPLOAD_ID } from '../dist/attachments.js';
import { assessDifficulty, userText } from '../dist/difficulty.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'kr-up-'));
const bytes = (n = 3) => new Uint8Array(n).fill(65);

test('a stored upload gets an id that names the file, lives only in the uploads folder, and resolves back', () => {
  const dir = tmp();
  const up = storeUpload(bytes(5), 'shot.png', dir);
  assert.match(up.id, UPLOAD_ID);
  assert.deepEqual([up.name, up.size], ['shot.png', 5]);
  assert.equal(fs.readFileSync(path.join(dir, up.id)).length, 5);
  assert.deepEqual(resolveAttachments([up.id], dir), { items: [{ id: up.id, name: 'shot.png', path: path.join(dir, up.id) }] });
  assert.deepEqual(resolveAttachments(undefined, dir), { items: [] });
  assert.notEqual(storeUpload(bytes(), 'shot.png', dir).id, up.id, 'two uploads of the same name never overwrite each other');
});

test('a hostile file name cannot escape the folder or smuggle a path', () => {
  const dir = tmp();
  for (const evil of ['..\\..\\evil.txt', '../../evil.txt', 'C:\\Windows\\win.ini', 'a/b/c.txt', '', '???']) {
    const up = storeUpload(bytes(), evil, dir);
    assert.match(up.id, UPLOAD_ID, evil);
    assert.deepEqual(fs.readdirSync(dir).filter((f) => !UPLOAD_ID.test(f)), [], `${evil}: only well-formed ids on disk`);
    assert.equal(path.dirname(path.join(dir, up.id)), dir);
  }
  assert.equal(displayName(storeUpload(bytes(), '..\\..\\evil.txt', dir).id), 'evil.txt');
});

test('empty and oversized files are refused with a sentence', () => {
  const dir = tmp();
  assert.throws(() => storeUpload(new Uint8Array(0), 'a.txt', dir), /empty/);
  assert.throws(() => storeUpload(new Uint8Array(MAX_FILE_BYTES + 1), 'a.bin', dir), /too large \(max 20 MB\)/);
  assert.equal(fs.readdirSync(dir).length, 0, 'nothing is left behind');
});

test('only ids this system made are accepted, so a client cannot point an agent at an arbitrary file', () => {
  const dir = tmp();
  for (const bad of ['../../.env', 'C:\\Windows\\win.ini', '/etc/passwd', 'shot.png', '1731000000000-a1b2c3_../x', 7, null, {}]) {
    assert.deepEqual(resolveAttachments([bad], dir), { error: 'that attachment id is not valid' }, String(bad));
  }
  assert.deepEqual(resolveAttachments('shot.png', dir), { error: 'attachments must be a list of upload ids' });
  const up = storeUpload(bytes(), 'a.txt', dir);
  assert.match(resolveAttachments(Array(MAX_FILES + 1).fill(up.id), dir).error, /at most 5 files/);
  const gone = '1731000000001-ffffff_old.pdf';
  assert.match(resolveAttachments([gone], dir).error, /old\.pdf is no longer available.*attach it again/);
});

test('removing an upload deletes it, once, and refuses anything that is not an id', () => {
  const dir = tmp();
  const up = storeUpload(bytes(), 'a.txt', dir);
  assert.equal(removeUpload(up.id, dir), true);
  assert.equal(removeUpload(up.id, dir), false);
  assert.equal(removeUpload('..\\..\\x', dir), false);
});

test('the block the agent reads is pinned (warroom/attachments.py builds the same text)', () => {
  const block = attachmentBlock([{ id: 'x', name: 'shot.png', path: 'C:\\up\\x_shot.png' }, { id: 'y', name: 'a.pdf', path: 'C:\\up\\y_a.pdf' }]);
  assert.equal(block, '\n\n[Attached files: the user attached these. Open each with your file tools (images and PDFs too) before you answer.]'
    + '\n- shot.png: C:\\up\\x_shot.png\n- a.pdf: C:\\up\\y_a.pdf\n[end of attached files]');
  assert.equal(attachmentBlock([]), '');
  assert.equal(hasAttachments('look' + block), true);
  assert.equal(hasAttachments('look'), false);
  assert.equal(withoutAttachments('look at this' + block), 'look at this');
});

test('file paths are not difficulty: the same question costs the same with or without files', () => {
  const block = attachmentBlock([{ id: 'x', name: 'a.png', path: 'C:\\very\\long\\path\\to\\workspace\\uploads\\' + 'x'.repeat(300) + '.png' }]);
  const memory = '[Memory context]\n- something\n\n[user]\n';
  for (const q of ['summarise this design', 'what is wrong with the layout here?']) {
    const plain = assessDifficulty(q), withFile = assessDifficulty(q + block), withMemory = assessDifficulty(memory + q + block);
    assert.deepEqual([withFile.tier, withFile.level, withFile.score], [plain.tier, plain.level, plain.score], q);
    assert.deepEqual([withMemory.tier, withMemory.level], [plain.tier, plain.level], q);
  }
  assert.equal(userText(memory + 'hello' + block), 'hello');
});

test('an attachment always keeps the agent\'s tools: an easy question about a file is never run tool-less', () => {
  const block = attachmentBlock([{ id: 'x', name: 'a.png', path: 'C:\\up\\x_a.png' }]);
  assert.equal(assessDifficulty('summarise this design').light, true, 'sanity: without a file this easy question may run light');
  assert.equal(assessDifficulty('summarise this design' + block).light, false);
});
