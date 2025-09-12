// File: scripts/twilio-ws-server.ts
/* eslint-disable no-console */
import http from "http";
import { WebSocketServer, WebSocket } from "ws";
import { parse as parseUrl } from "url";

const PORT = Number(process.env.TWILIO_WS_PORT ?? 8787);

type MediaStartPayload = {
  accountSid: string;
  streamSid: string;
  callSid: string;
  tracks?: string[];
  customParameters?: Record<string, string>;
};

type MediaFrame = {
  event: "media";
  media: { payload: string; track?: string; chunk?: number; timestamp?: string };
  streamSid: string;
};

type StartFrame = {
  event: "start";
  start: MediaStartPayload;
  streamSid: string;
};

type StopFrame = {
  event: "stop";
  streamSid: string;
};

type MarkFrame = {
  event: "mark";
  mark: { name: string };
  streamSid: string;
};

type AnyTwilioFrame = MediaFrame | StartFrame | StopFrame | MarkFrame;

type UserCtx = {
  userId: string;
  callSid?: string;
  streamSid?: string;
};

// ---- Stub: wire this to your actual OpenAI Realtime session factory later ----
async function createRealtimeSession(ctx: UserCtx): Promise<{ close: () => Promise<void>; sendAudio: (base64: string) => void }> {
  console.log(`[Realtime] create session for userId=${ctx.userId} callSid=${ctx.callSid} streamSid=${ctx.streamSid}`);
  // TODO: Connect to OpenAI Realtime API, attach audio-in from Twilio, audio-out back to Twilio (or TTS route)
  return {
    close: async () => {
      console.log("[Realtime] session closed");
    },
    sendAudio: (b64) => {
      // This is where you'd forward audio to your model stream
      // For now, just count bytes
      // Each base64 payload is μ-law 8k PCM from Twilio by default (unless configured otherwise)
      void b64;
    },
  };
}

// ---- HTTP server + WS upgrade handling ----
const server = http.createServer((req, res) => {
  if (!req.url) return;
  if (req.url === "/healthz") {
    res.writeHead(200).end("ok");
    return;
  }
  res.writeHead(404).end("Not Found");
});

const wss = new WebSocketServer({ noServer: true });

wss.on("connection", (ws: WebSocket, request: http.IncomingMessage, userCtx: UserCtx) => {
  console.log(`[WS] Connected: userId=${userCtx.userId}`);

  let session: Awaited<ReturnType<typeof createRealtimeSession>> | null = null;

  ws.on("message", async (data: WebSocket.RawData) => {
    let msg: AnyTwilioFrame;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      console.warn("[WS] Non-JSON message received; ignoring");
      return;
    }

    switch (msg.event) {
      case "start": {
        const s = msg as StartFrame;
        userCtx.callSid = s.start.callSid;
        userCtx.streamSid = s.streamSid;

        console.log(
          `[Twilio][start] callSid=${s.start.callSid} streamSid=${s.streamSid} tracks=${(s.start.tracks ?? []).join(",")}`
        );
        session = await createRealtimeSession(userCtx);
        break;
      }

      case "media": {
        const m = msg as MediaFrame;
        // Forward base64 payload to model (stubbed)
        session?.sendAudio(m.media.payload);
        break;
      }

      case "mark": {
        const mk = msg as MarkFrame;
        console.log(`[Twilio][mark] ${mk.mark.name} streamSid=${mk.streamSid}`);
        break;
      }

      case "stop": {
        const st = msg as StopFrame;
        console.log(`[Twilio][stop] streamSid=${st.streamSid}`);
        await session?.close();
        session = null;
        // Twilio will close shortly after; we can also proactively close.
        ws.close(1000, "done");
        break;
      }

      default:
        console.log("[Twilio] Unknown event", (msg as any).event);
    }
  });

  ws.on("close", async () => {
    console.log("[WS] Closed");
    await session?.close();
  });

  ws.on("error", (err) => {
    console.error("[WS] Error", err);
  });
});

server.on("upgrade", (req, socket, head) => {
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

server.listen(PORT, () => {
  console.log(`[Twilio WS] Listening on :${PORT} (path: /twilio-media)`);
});
