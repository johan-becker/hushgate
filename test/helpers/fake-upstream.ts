/**
 * A local stand-in for api.openai.com / api.anthropic.com.
 *
 * Every proxy test runs against this: it records exactly what hushgate sent,
 * which is the only way to assert the real claim — that personal data never
 * left the machine. Nothing in the test suite ever touches the network.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface RecordedRequest {
  readonly method: string;
  readonly path: string;
  readonly headers: Record<string, string | string[] | undefined>;
  readonly body: string;
  /** The body parsed as JSON, or `null` when it was not JSON. */
  readonly json: unknown;
}

export interface FakeReply {
  readonly status?: number;
  readonly headers?: Record<string, string>;
  readonly body: string;
  /** Write the body in these pieces, in order, instead of all at once. */
  readonly chunks?: readonly string[];
  /** Milliseconds to wait between chunks. */
  readonly chunkDelayMs?: number;
  /** Never answer at all — used to exercise the upstream timeout. */
  readonly hang?: boolean;
}

export type FakeHandler = (request: RecordedRequest) => FakeReply | Promise<FakeReply>;

export interface FakeUpstream {
  readonly origin: string;
  readonly requests: RecordedRequest[];
  /** The most recent request, or `undefined` when none arrived. */
  readonly lastRequest: RecordedRequest | undefined;
  setHandler(handler: FakeHandler): void;
  close(): Promise<void>;
}

const jsonReply = (payload: unknown): FakeReply => ({
  status: 200,
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(payload),
});

export async function startFakeUpstream(initial?: FakeHandler): Promise<FakeUpstream> {
  const requests: RecordedRequest[] = [];
  let handler: FakeHandler = initial ?? ((): FakeReply => jsonReply({ ok: true }));

  const server: Server = createServer((request, response) => {
    void receive(request, response);
  });

  async function receive(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk as Buffer);
    const body = Buffer.concat(chunks).toString('utf8');

    let json: unknown = null;
    try {
      json = JSON.parse(body);
    } catch {
      json = null;
    }

    const recorded: RecordedRequest = {
      method: request.method ?? 'GET',
      path: request.url ?? '/',
      headers: request.headers,
      body,
      json,
    };
    requests.push(recorded);

    const reply = await handler(recorded);
    if (reply.hang === true) return;

    response.writeHead(reply.status ?? 200, reply.headers ?? { 'content-type': 'application/json' });

    if (reply.chunks === undefined) {
      response.end(reply.body);
      return;
    }

    for (const piece of reply.chunks) {
      response.write(piece);
      if ((reply.chunkDelayMs ?? 0) > 0) {
        // Sequential on purpose: the point is to space the chunks out in time.
        // oxlint-disable-next-line no-await-in-loop
        await new Promise((resolve) => setTimeout(resolve, reply.chunkDelayMs));
      }
    }
    response.end();
  }

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as AddressInfo;

  return {
    origin: `http://127.0.0.1:${address.port}`,
    requests,
    get lastRequest(): RecordedRequest | undefined {
      return requests.at(-1);
    },
    setHandler(next: FakeHandler): void {
      handler = next;
    },
    close(): Promise<void> {
      return new Promise((resolve, reject) => {
        server.closeAllConnections();
        server.close((error) => (error === undefined ? resolve() : reject(error)));
      });
    },
  };
}

/** Convenience: reply with this JSON payload to every request. */
export function replyJson(payload: unknown): FakeHandler {
  return () => jsonReply(payload);
}
