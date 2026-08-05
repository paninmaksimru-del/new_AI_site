/**
 * Локальный превью-сервер статики из /public без PostgreSQL и npm-зависимостей.
 * Поддерживает те же pretty URLs, что и основной Express-сервер.
 */
import { createReadStream, statSync } from 'node:fs';
import { join, dirname, normalize, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';

const __dirname = dirname(fileURLToPath(import.meta.url));
const publicDir = join(__dirname, '..', 'public');
const port = Number(process.env.PREVIEW_PORT) || 5050;

const pages = {
  '/': 'index.html',
  '/index_new': 'index_new.html',
  '/login': 'login.html',
  '/dashboard': 'dashboard.html',
  '/admin': 'admin.html',
  '/profile': 'profile.html',
  '/training': 'education.html',
  '/education': 'education.html',
  '/cases': 'cases.html',
  '/anonymizer': 'anonymizer.html',
  '/chat': 'chat.html',
  '/knowledge': 'knowledge.html',
  '/knowledgev2': 'knowledgev2.html',
  '/audio-assistant': 'audio-assistant.html',
};

const types = {
  '.css': 'text/css; charset=utf-8',
  '.gif': 'image/gif',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
};

function resolvePublicPath(urlPath) {
  const cleanPath = decodeURIComponent(urlPath.split('?')[0] || '/');
  const routeFile = pages[cleanPath];
  const relative = routeFile || cleanPath.replace(/^\/+/, '');
  const resolved = normalize(join(publicDir, relative));
  if (!resolved.startsWith(publicDir)) return null;
  return resolved;
}

createServer((req, res) => {
  const filePath = resolvePublicPath(req.url || '/');
  res.setHeader('Cache-Control', 'no-store');

  if (!filePath) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  let stats;
  try {
    stats = statSync(filePath);
  } catch (_) {
    res.writeHead(404);
    res.end('Not found');
    return;
  }

  if (!stats.isFile()) {
    res.writeHead(404);
    res.end('Not found');
    return;
  }

  res.writeHead(200, {
    'Content-Type': types[extname(filePath).toLowerCase()] || 'application/octet-stream',
    'Content-Length': stats.size,
  });
  if (req.method === 'HEAD') {
    res.end();
    return;
  }
  createReadStream(filePath).pipe(res);
}).listen(port, '127.0.0.1', () => {
  console.log(`Preview (static): http://127.0.0.1:${port}/login`);
  console.log('Без БД: /api/* недоступны.');
});
