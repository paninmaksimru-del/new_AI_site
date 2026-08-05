import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const root = new URL('../', import.meta.url);

test('все API чата требуют авторизацию и фильтруют данные по user_id', async () => {
  const routes = await readFile(new URL('server/qwen-chat-routes.js', root), 'utf8');
  const routeDeclarations = [...routes.matchAll(/app\.(?:get|post|patch|delete)\('([^']*\/api\/chat[^']*)',\s*([^,\n]+)/g)];

  assert.ok(routeDeclarations.length >= 9, 'ожидаются все маршруты chat API');
  for (const [, path, middleware] of routeDeclarations) {
    assert.match(middleware, /\bauth\b/, `${path} должен быть защищён auth middleware`);
  }

  assert.match(routes, /SELECT \* FROM ai_chats WHERE id = \$1 AND user_id = \$2/);
  assert.match(routes, /WHERE c\.user_id = \$1/);
  assert.match(routes, /REFERENCES users\(id\) ON DELETE CASCADE/);
  assert.match(routes, /SELECT id FROM ai_chat_projects WHERE id = \$1 AND user_id = \$2/);
});

test('удаление чата ограничено владельцем и подтверждает факт удаления', async () => {
  const routes = await readFile(new URL('server/qwen-chat-routes.js', root), 'utf8');
  const start = routes.indexOf("app.delete('/api/chat/sessions/:id'");
  const end = routes.indexOf("app.post('/api/chat/completions'", start);
  const deletion = routes.slice(start, end);

  assert.ok(start >= 0 && end > start);
  assert.match(deletion, /DELETE FROM ai_chats WHERE id = \$1 AND user_id = \$2 RETURNING id/);
  assert.match(deletion, /\[req\.params\.id, req\.user\.id\]/);
  assert.match(deletion, /if \(!rows\[0\]\) return res\.status\(404\)/);
});

test('файлы можно выбрать или перетащить в чат с одинаковой валидацией', async () => {
  const [html, script] = await Promise.all([
    readFile(new URL('public/chat.html', root), 'utf8'),
    readFile(new URL('public/chat.js', root), 'utf8')
  ]);

  assert.match(html, /id="dropZoneOverlay"/);
  assert.match(script, /function addPendingFiles\(fileList\)/);
  assert.match(script, /MAX_PENDING_FILES = 5/);
  assert.match(script, /MAX_FILE_SIZE_BYTES = 15 \* 1024 \* 1024/);
  assert.match(script, /chatRoot\.addEventListener\('dragenter'/);
  assert.match(script, /chatRoot\.addEventListener\('dragover'/);
  assert.match(script, /chatRoot\.addEventListener\('drop'/);
  assert.match(script, /addPendingFiles\(event\.target\.files\)/);
  assert.match(script, /addPendingFiles\(files\)/);
});
