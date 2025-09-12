/* eslint-disable no-console */
import http from "http";
import { parse as parseUrl } from "url";
import next from "next";
import { WebSocketServer, WebSocket } from "ws";

const dev = process.env.NODE_ENV !== "production";
const app = next({ dev });
const handle = app.getRequestHandler();

type UserCtx = { userId: string; callSid?: string; streamSid?: string };

type StartFrame = {
  event: "start";
  start: { accountSid: string; streamSid: string; callSid: string; tracks?: string[] };
  streamSid: string;
};
type MediaFrame = { event: "media"; media: { payload: string }; streamSid: string };
type StopFrame = { event: "stop"; streamSid: string };
type MarkFrame = { event: "mark"; mark: { name: string }; streamSid: string };
type AnyTwilioFrame = StartFrame | MediaFrame | StopFrame | MarkFrame;

// Stub your realtime session here
async function createRealtimeSession(ctx: UserCtx): Promise<{ close: () => Promise<void>; sendAudio: (b64: string) => void }> {
  console.log(`[Realtime] session for userId=${ctx.userId} callSid=${ctx.callSid} streamSid=${ctx.streamSid}`);
  return {
    close: async () => console.log("[Realtime] session closed"),
    sendAudio: (b64) => void b64,
  };
}

async function main() {
  await app.prepare();

  // Create one HTTP server for both Next requests and WS upgrades
  const server = http.createServer(async (req, res) => {
    if (!req.url) return;
    // simple health check (handy for TLS tests)
    if (req.url === "/healthz") {
      res.writeHead(200).end("ok");
      return;
    }
    return handle(req, res, parseUrl(req.url, true));
  });

  const wss = new WebSocketServer({ noServer: true });

  wss.on("connection", (ws: WebSocket, request: http.IncomingMessage, userCtx: UserCtx) => {
    console.log(`[WS] Connected: userId=${userCtx.userId}`);
    let session: Awaited<ReturnType<typeof createRealtimeSession>> | null = null;
    let streamSid: string | null = null;

    ws.on("message", async (data) => {
      let msg: AnyTwilioFrame;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        console.warn("[WS] non-JSON frame");
        return;
      }

      switch (msg.event) {
        case "start": {
          const s = msg as StartFrame;
          userCtx.callSid = s.start.callSid;
          userCtx.streamSid = s.streamSid;
          streamSid = s.streamSid;
          console.log(`[Twilio][start] callSid=${s.start.callSid} streamSid=${s.streamSid}`);
          session = await createRealtimeSession(userCtx);
          break;
        }
        case "media": {
          const m = msg as MediaFrame;
          // Forward to your model (still stubbed)
          session?.sendAudio(m.media.payload);

          // 🔊 Loopback to Twilio so the caller hears themselves (proof of life)
          if (streamSid) {
            const echo = {
              event: "media",
              streamSid,
              media: { payload: m.media.payload }, // base64 PCMU back to Twilio
            };
            ws.send(JSON.stringify(echo));
          }
          break;
        }
        case "mark": {
          const mk = msg as MarkFrame;
          console.log(`[Twilio][mark] ${mk.mark.name}`);
          break;
        }
        case "stop": {
          const st = msg as StopFrame;
          console.log(`[Twilio][stop] streamSid=${st.streamSid}`);
          await session?.close();
          session = null;
          ws.close(1000, "done");
          break;
        }
        default:
          console.log("[Twilio] unknown event");
      }
    });

    ws.on("close", async () => {
      console.log("[WS] Closed");
      await session?.close();
    });

    ws.on("error", (e) => console.error("[WS] Error", e));
  });

  server.on("upgrade", (req, socket, head) => {
    console.log("[UPGRADE]", (req.url ?? "").split("?")[0], "proto:", req.headers["sec-websocket-protocol"]);
    const url = parseUrl(req.url ?? "", true);
    if (url.pathname !== "/twilio-media") {
      socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
      socket.destroy();
      return;
    }
    const userId = String(url.query.userId ?? "guest");
    const userCtx: UserCtx = { userId };
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit("connection", ws, req, userCtx);
    });
  });

  const port = Number(process.env.PORT || 3000);
  server.listen(port, () => {
    console.log(`[NEXT+WS] Listening on :${port} (WS path: /twilio-media)`);
  });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
