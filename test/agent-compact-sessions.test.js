import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { Agent } from '../lib/agent.js';
import Context from '../lib/context.js';
import { scriptedIO, testEnv, TEXT, USER } from './fakes.js';

const reply = () => scriptedIO([[...TEXT(0, 'summary'), { type: 'done' }]]);

describe('compaction preserves earlier sessions', () => {
  test('logged named session remains resumable, continuations increment without overwriting', async () => {
    const env = await testEnv();
    const agent = await Agent.create({ env, model: 'p/m', contextId: 'project', context: [USER('original')], createIO: reply });
    try {
      const first = agent.context;
      first.flush();
      const file = first.file;
      await agent.compact();
      expect(agent.context).not.toBe(first);
      expect(agent.context.id).toBe('project-cont-001');
      expect(agent.context.name).toBe('project cont 001');
      expect(Context.fileOf({ dir: env.settings.sessions, id: 'project' })).toBe(file);
      expect(Context.resume({ dir: env.settings.sessions, id: 'project' }).messages()).toEqual([USER('original')]);
      expect(readFileSync(file, 'utf8')).not.toContain('Create a detailed summary');
      agent.context.append(USER('next'));
      await agent.compact();
      expect(agent.context.id).toBe('project-cont-002');
      expect(Context.resume({ dir: env.settings.sessions, id: 'project-cont-001' }).messages()).toContainEqual(USER('next'));
    } finally { await agent.close(); await env.close(); }
  });
  test('automatic compaction archives the held-out user message in the old session', async () => {
    const env = await testEnv();
    env.settings.context = { autocompact: 0.4 };
    const io = scriptedIO([[...TEXT(0, 'summary'), { type: 'done' }], [...TEXT(0, 'answer'), { type: 'done' }]],
      { onRequest: (running, index) => { if (index === 0) running.context.contextUsage = { used: 90, total: 100 }; } });
    const agent = await Agent.create({ env, model: 'p/m', contextId: 'auto', context: [USER('original'), { type: Context.MessageType.Assistant, content: [{ type: 'text', text: 'reply' }] }, USER('waiting')], createIO: () => io });
    try {
      agent.context.contextUsage = { used: 90, total: 100 };
      await agent.run();
      expect(agent.context.id).toBe('auto-cont-001');
      const archived = Context.resume({ dir: env.settings.sessions, id: 'auto' }).messages();
      expect(archived.at(-1)).toEqual(USER('waiting'));
      expect(archived.some((m) => m.content?.some((b) => b.text?.includes('Create a detailed summary')))).toBe(false);
    } finally { await agent.close(); await env.close(); }
  });
  test('memory-only compaction stays memory-only', async () => {
    const env = await testEnv();
    const agent = await Agent.create({ env, model: 'p/m', contextId: false, context: [USER('original')], createIO: reply });
    try {
      const old = agent.context;
      await agent.compact();
      expect(agent.context).not.toBe(old);
      expect(agent.context.id).toBeUndefined();
      expect(agent.context.save).toBe(false);
    } finally { await agent.close(); await env.close(); }
  });
  test('anonymous logged id gets a new id without losing prior file', async () => {
    const env = await testEnv();
    const agent = await Agent.create({ env, model: 'p/m', contextId: crypto.randomUUID(), context: [USER('original')], createIO: reply });
    try {
      const old = agent.context;
      old.flush();
      await agent.compact();
      expect(agent.context.id).not.toBe(old.id);
      expect(Context.fileOf({ dir: env.settings.sessions, id: old.id })).toBe(old.file);
      expect(Context.fileOf({ dir: env.settings.sessions, id: agent.context.id })).toBe(agent.context.file);
    } finally { await agent.close(); await env.close(); }
  });
});
