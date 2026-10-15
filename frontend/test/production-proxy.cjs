const http = require("node:http");
const origin = "https://geoturing.com";
const cache = new Map();

// Test-only origin isolation. Serve deployed bytes unchanged. The deployed
// frontend still connects directly to the production API and Socket.IO server.
// Starting this proxy alone does not create games or change production data.
const server = http.createServer(async (request, response) => {
  if (request.method !== "GET" && request.method !== "HEAD") {
    response.writeHead(405).end();
    return;
  }

  try {
    const path = new URL(request.url, "http://127.0.0.1").pathname;
    let item = cache.get(path);
    if (!item) {
      const upstream = await fetch(new URL(path, origin));
      item = {
        status: upstream.status,
        type: upstream.headers.get("content-type"),
        body: Buffer.from(await upstream.arrayBuffer()),
      };
      if (upstream.ok) cache.set(path, item);
    }
    response.writeHead(item.status, {
      "Content-Type": item.type || "application/octet-stream",
      "Cache-Control": "no-store",
    });
    response.end(request.method === "HEAD" ? undefined : item.body);
  } catch (error) {
    response.writeHead(502, { "Content-Type": "text/plain" }).end("Production frontend unavailable.");
    console.error(error.message);
  }
});

// A fresh port gives the second player fresh localStorage without clearing any
// existing browser data. Bind only to this computer, never a public interface.
server.listen(0, "127.0.0.1", () => {
  console.log(`Unmodified production frontend proxy: http://127.0.0.1:${server.address().port}`);
});
