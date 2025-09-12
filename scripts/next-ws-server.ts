/* eslint-disable no-console */
import http from "http";
import { parse as parseUrl } from "url";
import next from "next";
import { WebSocketServer, WebSocket } from "ws";

// ---- Realtime config ----
const REALTIME_MODEL = process.env.REALTIME_MODEL || "gpt-realtime";
const VOICE = process.env.REALTIME_VOICE || "alloy";
if (!process.env.OPENAI_API_KEY) {
  console.error("OPENAI_API_KEY missing");
}

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

// --- OpenAI Realtime session factory ---
async function createRealtimeSession(ctx: UserCtx): Promise<{
  socket: WebSocket;
  close: () => Promise<void>;
  sendAudio: (b64: string) => void;
}> {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error("OPENAI_API_KEY missing");
  }
  const rt = new WebSocket(
    `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(REALTIME_MODEL)}`,
    {
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        "OpenAI-Beta": "realtime=v1",
      },
    }
  );

  let open = false;
  let hasAudioInBuffer = false;
  let silenceTimer: NodeJS.Timeout | null = null;

  const commitNow = () => {
    if (!open || !hasAudioInBuffer) return;
    hasAudioInBuffer = false;
    try {
      rt.send(JSON.stringify({ type: "input_audio_buffer.commit" }));
      // Prompt the model to produce audio output now
      rt.send(JSON.stringify({ type: "response.create" }));
    } catch {}
  };
  const scheduleCommit = () => {
    if (silenceTimer) clearTimeout(silenceTimer);
    silenceTimer = setTimeout(commitNow, 300);
  };

  rt.on("open", () => {
    open = true;
    const sessionUpdate = {
      type: "session.update",
      session: {
        instructions: "You are a helpful, concise voice assistant for phone calls.",
        input_audio_format: { type: "pcmu" },   // μ-law from Twilio
        output_audio_format: { type: "pcmu" },  // μ-law back to Twilio
        turn_detection: { type: "server_vad" },
        voice: VOICE,
      },
    };
    rt.send(JSON.stringify(sessionUpdate));

    // 👋 Have the model speak first with a short greeting
    const greeting = {
      type: "conversation.item.create",
      item: {
        type: "message",
        role: "user",
        content: [
          {
            type: "input_text",
            text: "Greet the caller briefly (under 5 seconds). Introduce yourself and ask how you can help.",
          },
        ],
      },
    };
    rt.send(JSON.stringify(greeting));
    rt.send(JSON.stringify({ type: "response.create" }));
  });
  rt.on("error", (e) => console.error("[Realtime] socket error", e));
  rt.on("close", () => { open = false; });

  return {
    socket: rt,
    sendAudio: (b64: string) => {
      if (!open) return;
      try {
        rt.send(JSON.stringify({ type: "input_audio_buffer.append", audio: b64 }));
        hasAudioInBuffer = true;
        scheduleCommit();
      } catch {}
    },
    close: async () => {
      try { commitNow(); rt.close(); } catch {}
    },
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

  const wss = new WebSocketServer({
    noServer: true,
    // Twilio sends Sec-WebSocket-Protocol: audio
    handleProtocols: (protocols) => (protocols.includes("audio") ? "audio" : protocols[0] ?? false),
  });

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

          // 🔊 Model → Twilio: forward OpenAI audio deltas back to the caller
          session.socket.on("message", (raw) => {
            try {
              const evt = JSON.parse(raw.toString());
              if (evt.type === "response.output_audio.delta" && evt.delta && streamSid) {
                ws.send(JSON.stringify({
                  event: "media",
                  streamSid,
                  media: { payload: evt.delta } // base64 μ-law
                }));
              }
            } catch (e) {
              console.error("[Realtime] parse message err", e);
            }
          });
          break;
        }
        case "media": {
          const m = msg as MediaFrame;
          // Twilio → Model (append μ-law base64 audio)
          session?.sendAudio(m.media.payload);
          break;
        }
        case "mark":
          // optional: handle marks if you need timing
          break;
        case "stop": {
          const st = msg as StopFrame;
          console.log(`[Twilio][stop] streamSid=${st.streamSid}`);
          await session?.close();
          session = null;
          ws.close(1000, "done");
          break;
        }
        case "connected":
        case "dtmf":
          // ignore
          break;
        default:
          console.log("[Twilio] unknown event", (msg as any).event);
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