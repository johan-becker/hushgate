/**
 * A local stand-in for an OpenAI-compatible provider.
 *
 * Every transcript in the README was produced against this file, so anyone can
 * reproduce them without an API key and without touching the network. It logs
 * the request body it received — which is the whole point of the exercise: you
 * get to read exactly what hushgate forwarded.
 *
 *     node examples/upstream.mjs
 *     hushgate serve -c examples/demo.config.json
 *
 * The reply quotes the placeholders back so that re-hydration is visible in the
 * response, and in streaming mode it cuts the reply into 12-character pieces so
 * that placeholders land across event boundaries on purpose.
 */
import { appendFileSync } from 'node:fs';
import { createServer } from 'node:http';

const PORT = Number(process.env.UPSTREAM_PORT ?? 9099);
const LOG = process.env.UPSTREAM_LOG ?? 'examples/upstream-received.log';
const PIECE = 12;

/** First placeholder of `kind` in `text`, so the reply can quote it back. */
function firstToken(text, kind) {
  const match = new RegExp(`\\[${kind}_\\d+\\]`, 'u').exec(text);
  return match === null ? `[${kind}_?]` : match[0];
}

/** The text of the last user message, in either content shape. */
function lastUserText(body) {
  const last = body.messages.at(-1);
  if (typeof last.content === 'string') return last.content;
  return last.content.map((part) => part.text ?? '').join('');
}

function chunkEvent(piece) {
  const payload = {
    id: 'chatcmpl-demo',
    object: 'chat.completion.chunk',
    choices: [{ index: 0, delta: { content: piece } }],
  };
  return `data: ${JSON.stringify(payload)}\n\n`;
}

const server = createServer((request, response) => {
  const parts = [];
  request.on('data', (chunk) => parts.push(chunk));
  request.on('end', () => {
    const raw = Buffer.concat(parts).toString('utf8');
    appendFileSync(LOG, `${request.method} ${request.url}\n${raw}\n`);

    const body = JSON.parse(raw);
    const text = lastUserText(body);
    const reply =
      `Alles klar. Ich schreibe an ${firstToken(text, 'EMAIL')} ` +
      `und buche auf ${firstToken(text, 'IBAN')}.`;

    if (body.stream === true) {
      response.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
      });
      for (let i = 0; i < reply.length; i += PIECE) {
        response.write(chunkEvent(reply.slice(i, i + PIECE)));
      }
      response.write('data: [DONE]\n\n');
      response.end();
      return;
    }

    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(
      JSON.stringify({
        id: 'chatcmpl-demo',
        object: 'chat.completion',
        model: body.model,
        choices: [
          {
            index: 0,
            message: { role: 'assistant', content: reply },
            finish_reason: 'stop',
          },
        ],
        usage: { prompt_tokens: 41, completion_tokens: 23, total_tokens: 64 },
      }),
    );
  });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`fake upstream on http://127.0.0.1:${PORT}`);
});
