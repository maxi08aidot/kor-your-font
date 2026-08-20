// Local static server for eyeballing site/ during development. Not shipped.
const http = require('http');
const fs = require('fs');
const path = require('path');
const root = process.cwd();
const port = Number(process.argv[2] || 8099);
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css',
  '.jpg': 'image/jpeg', '.png': 'image/png', '.woff2': 'font/woff2', '.ttf': 'font/ttf',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.wasm': 'application/wasm' };
http.createServer((req, res) => {
  const rel = decodeURIComponent(req.url.split('?')[0]).replace(/^\/+/, '');
  // site/ is the document root so relative URLs resolve as they do on Pages,
  // but repo paths still work so a test can pull in an ignored sample photo.
  const tries = [path.resolve(root, 'site', rel || 'index.html'), path.resolve(root, rel)];
  const file = tries.find((f) => f.startsWith(root) && fs.existsSync(f) && !fs.statSync(f).isDirectory());
  if (!file) {
    res.writeHead(404); return res.end('not found');
  }
  res.writeHead(200, { 'content-type': types[path.extname(file)] || 'application/octet-stream',
    'cache-control': 'no-store' });
  fs.createReadStream(file).pipe(res);
}).listen(port, () => console.log('serving ' + root + ' on ' + port));
