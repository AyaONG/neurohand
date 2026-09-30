import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";

// Только локальный просмотр: без установки зависимостей и внешних запросов.
const server = createServer(async (request, response) => {
  try {
    const path = new URL(request.url, "http://127.0.0.1").pathname;
    let body;
    let contentType;
    if (path === "/") {
      body = await readFile(new URL("./demo.html", import.meta.url), "utf8");
      contentType = "text/html; charset=utf-8";
    } else if (path === "/drawSmartHand.js") {
      const source = await readFile(new URL("./drawSmartHand.ts", import.meta.url), "utf8");
      body = stripTypeScriptTypes(source);
      contentType = "text/javascript; charset=utf-8";
    } else {
      response.writeHead(404).end("Not found");
      return;
    }
    response.writeHead(200, { "Content-Type": contentType, "Cache-Control": "no-store" });
    response.end(body);
  } catch (error) {
    console.error(error);
    response.writeHead(500).end("Unable to load local demo");
  }
});

server.on("error", (error) => {
  console.error(error);
  process.exitCode = 1;
});
// Постоянный локальный адрес сохраняет работоспособность открытой вкладки при перезапуске.
server.listen(52732, "127.0.0.1", () => {
  console.log(`Hand demo: http://127.0.0.1:${server.address().port}`);
});
