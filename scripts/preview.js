// Local-only preview and source transport for browser integration checks.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
http.createServer((request, response) => {
  const url = new URL(request.url, 'http://127.0.0.1');
  const name = path.resolve(root, '.' + decodeURIComponent(url.pathname === '/' ? '/popup/popup.html' : url.pathname));
  if (!name.startsWith(root + path.sep)) { response.writeHead(403).end(); return; }
  fs.readFile(name, (error, bytes) => {
    if (error) { response.writeHead(404).end(); return; }
    if (url.pathname === '/popup/popup.html' && url.searchParams.has('demo')) {
      bytes = Buffer.from(bytes.toString().replace('<head>', '<head><script src="/scripts/preview-mock.js"></script>'));
    }
    response.setHeader('Content-Type', ({ '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' })[path.extname(name)] || 'application/octet-stream');
    response.end(bytes);
  });
}).listen(Number(process.env.PORT || 8765), '127.0.0.1', function () {
  console.log(`Preview: http://127.0.0.1:${this.address().port}/popup/popup.html?demo`);
});
