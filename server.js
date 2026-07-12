const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");
const { execFile } = require("child_process");

const HOST = "0.0.0.0";
const PORT = Number(process.env.PORT || 10000);
const PROXY_TOKEN = process.env.PROXY_TOKEN || "yrp_D4CyHVNjrVcFpdR4Fovnxk79SkOBerjV";
const PUBLIC_DIR = path.join(__dirname, "public");
const MAX_BUFFER = 45 * 1024 * 1024;
const CACHE_LIMIT_BYTES = 48 * 1024 * 1024;

const cache = new Map();
let cacheBytes = 0;

function contentType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return {
    ".html": "text/html; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".aix": "application/octet-stream",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
    ".css": "text/css; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".txt": "text/plain; charset=utf-8",
  }[ext] || "application/octet-stream";
}

function send(res, status, headers, body) {
  res.writeHead(status, {
    "Access-Control-Allow-Origin": "*",
    "X-Content-Type-Options": "nosniff",
    ...headers,
  });
  res.end(body);
}

function validTarget(raw) {
  try {
    const url = new URL(raw);
    return (
      url.protocol === "https:" &&
      url.hostname === "stl.manhwa-online.com" &&
      /\.(webp|jpg|jpeg|png)$/i.test(url.pathname)
    );
  } catch {
    return false;
  }
}

function getCached(key) {
  const item = cache.get(key);
  if (!item) return null;
  cache.delete(key);
  cache.set(key, item);
  return item;
}

function putCached(key, item) {
  if (item.body.length > CACHE_LIMIT_BYTES / 2) return;
  if (cache.has(key)) {
    cacheBytes -= cache.get(key).body.length;
    cache.delete(key);
  }
  cache.set(key, item);
  cacheBytes += item.body.length;
  while (cacheBytes > CACHE_LIMIT_BYTES && cache.size > 0) {
    const oldest = cache.keys().next().value;
    const removed = cache.get(oldest);
    cache.delete(oldest);
    cacheBytes -= removed.body.length;
  }
}

function serveStatic(req, res) {
  let cleanPath = decodeURIComponent(req.url.split("?")[0]);
  if (cleanPath === "/") {
    const html = `<!doctype html>
<html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<title>YRepo Cloud</title><style>
body{font-family:system-ui;background:#05080d;color:#fff;max-width:760px;margin:70px auto;padding:24px}
h1{color:#36d9ff}code{background:#111a25;padding:4px 8px;border-radius:7px;word-break:break-all}
.card{border:1px solid #1f91bb;border-radius:18px;padding:22px;background:#09121c}
.ok{color:#76ffbd}
</style></head><body><div class="card">
<h1>YRepo Cloud</h1>
<p class="ok">● Proxy activo</p>
<p>Lista de fuentes para Aidoku:</p>
<p><code>${new URL(req.url, "http://" + req.headers.host).origin}/index.min.json</code></p>
</div></body></html>`;
    send(res, 200, {"Content-Type":"text/html; charset=utf-8"}, html);
    return true;
  }

  const relative = cleanPath.replace(/^\/+/, "");
  const filePath = path.resolve(PUBLIC_DIR, relative);
  const publicResolved = path.resolve(PUBLIC_DIR);

  if (!filePath.startsWith(publicResolved + path.sep) && filePath !== publicResolved) {
    send(res, 403, {"Content-Type":"text/plain; charset=utf-8"}, "Acceso denegado");
    return true;
  }

  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) return false;

  const stat = fs.statSync(filePath);
  res.writeHead(200, {
    "Content-Type": contentType(filePath),
    "Content-Length": stat.size,
    "Cache-Control": filePath.endsWith("index.min.json")
      ? "no-cache"
      : "public, max-age=3600",
    "Access-Control-Allow-Origin": "*",
  });
  if (req.method === "HEAD") {
    res.end();
  } else {
    fs.createReadStream(filePath).pipe(res);
  }
  return true;
}

const server = http.createServer((req, res) => {
  const requestUrl = new URL(req.url, `http://${req.headers.host || "localhost"}`);

  if (requestUrl.pathname === "/health") {
    return send(res, 200, {"Content-Type":"text/plain; charset=utf-8"}, "YRepo Cloud OK");
  }

  if (requestUrl.pathname === "/image") {
    if (requestUrl.searchParams.get("token") !== PROXY_TOKEN) {
      return send(res, 403, {"Content-Type":"text/plain; charset=utf-8"}, "Token inválido");
    }

    const target = requestUrl.searchParams.get("url");
    if (!target || !validTarget(target)) {
      return send(res, 400, {"Content-Type":"text/plain; charset=utf-8"}, "URL no permitida");
    }

    const cached = getCached(target);
    if (cached) {
      return send(res, 200, {
        "Content-Type": cached.contentType,
        "Cache-Control": "public, max-age=31536000, immutable",
        "Content-Length": String(cached.body.length),
      }, cached.body);
    }

    const args = [
      "-4", "--http1.1",
      "-L", "--fail", "--silent", "--show-error",
      "--max-time", "45",
      "--retry", "2", "--retry-delay", "1",
      "-A", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/142 Safari/537.36",
      "-H", "Accept: image/webp,image/apng,image/*,*/*;q=0.8",
      "-H", "Referer: https://manhwa-online.com/",
      "-H", "Accept-Language: es-CL,es;q=0.9,en;q=0.8",
      "-H", "Sec-Fetch-Dest: image",
      "-H", "Sec-Fetch-Mode: no-cors",
      "-H", "Sec-Fetch-Site: same-site",
      target,
    ];

    execFile("curl", args, {encoding:"buffer", maxBuffer:MAX_BUFFER}, (error, stdout, stderr) => {
      if (error || !stdout || stdout.length === 0) {
        const detail = stderr ? stderr.toString("utf8").slice(0, 600) : String(error || "sin datos");
        console.error("Proxy error:", target, detail);
        return send(res, 502, {"Content-Type":"text/plain; charset=utf-8"},
          `No se pudo obtener la imagen.\n${detail}`);
      }

      const lower = target.toLowerCase();
      const type = lower.endsWith(".webp") ? "image/webp"
        : lower.endsWith(".png") ? "image/png" : "image/jpeg";
      const item = {body:stdout, contentType:type};
      putCached(target, item);
      console.log(`OK ${stdout.length} bytes ${target}`);
      return send(res, 200, {
        "Content-Type": type,
        "Cache-Control": "public, max-age=31536000, immutable",
        "Content-Length": String(stdout.length),
      }, stdout);
    });
    return;
  }

  if (!serveStatic(req, res)) {
    send(res, 404, {"Content-Type":"text/plain; charset=utf-8"}, "No encontrado");
  }
});

server.listen(PORT, HOST, () => {
  console.log(`YRepo Cloud escuchando en 0.0.0.0:${PORT}`);
});
