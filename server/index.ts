import "dotenv/config";
import { createServer } from "node:http";
import next from "next";
import { attachWebSocketServer } from "../src/lib/ws-server";

const dev = process.env.NODE_ENV !== "production";
const port = Number(process.env.PORT) || 3000;

const app = next({ dev });
const handle = app.getRequestHandler();

app
  .prepare()
  .then(() => {
    const httpServer = createServer((req, res) => {
      handle(req, res);
    });

    attachWebSocketServer(httpServer);

    httpServer.listen(port, () => {
      console.log(
        `> FireChat ready on http://localhost:${port} (${dev ? "development" : process.env.NODE_ENV})`
      );
    });
  })
  .catch((err) => {
    console.error("Failed to start server:", err);
    process.exit(1);
  });
