import {
  createChatInputSchema,
  paginationQuerySchema,
  sendMessageInputSchema,
  updateChatInputSchema,
} from '@ai-chat/contracts';
import { Hono } from 'hono';
import type { AppDeps, AppEnv } from '../deps';
import { parseJson, parseQuery } from '../lib/validation';
import { ChatService } from '../services/chat-service';
import { GenerationService } from '../services/generation-service';

export function chatRoutes(deps: AppDeps) {
  const chats = new ChatService(deps);
  const generation = new GenerationService(deps, chats);
  const r = new Hono<AppEnv>();

  r.get('/chats', async (c) => {
    const q = parseQuery(c, paginationQuerySchema);
    return c.json(await chats.list(c.get('user').sub, q.limit ?? 30, q.cursor));
  });

  r.post('/chats', async (c) => {
    const input = await parseJson(c, createChatInputSchema);
    return c.json(await chats.create(c.get('user').sub, input.title), 201);
  });

  r.get('/chats/:chatId', async (c) => c.json(await chats.get(c.get('user').sub, c.req.param('chatId'))));

  r.patch('/chats/:chatId', async (c) => {
    const input = await parseJson(c, updateChatInputSchema);
    return c.json(await chats.rename(c.get('user').sub, c.req.param('chatId'), input.title));
  });

  r.delete('/chats/:chatId', async (c) => {
    await chats.delete(c.get('user').sub, c.req.param('chatId'));
    return c.body(null, 204);
  });

  r.get('/chats/:chatId/messages', async (c) => {
    const q = parseQuery(c, paginationQuerySchema);
    return c.json(await chats.listMessages(c.get('user').sub, c.req.param('chatId'), q.limit ?? 50, q.cursor));
  });

  r.post('/chats/:chatId/stream', async (c) => {
    const input = await parseJson(c, sendMessageInputSchema);
    return generation.start({
      user: c.get('user'),
      chatId: c.req.param('chatId'),
      input,
      requestSignal: c.req.raw.signal,
      requestId: c.get('requestId'),
      logger: c.get('logger'),
    });
  });

  r.get('/usage', async (c) => c.json(await chats.usage(c.get('user').sub)));

  return r;
}
