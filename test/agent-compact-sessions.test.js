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
      expect(agent.context.id).toBe('project-1');
      expect(agent.context.name).toBe('project-1');
      expect(Context.fileOf({ dir: env.settings.sessions, id: 'project' })).toBe(file);
      expect(Context.resume({ dir: env.settings.sessions, id: 'project' }).messages()).toEqual([USER('original')]);
      expect(readFileSync(file, 'utf8')).not.toContain('Create a detailed summary');
      agent.context.append(USER('next'));
      await agent.compact();
      expect(agent.context.id).toBe('project-2');
      expect(Context.resume({ dir: env.settings.sessions, id: 'project-1' }).messages()).toContainEqual(USER('next'));
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
      expect(agent.context.id).toBe('auto-1');
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

for (const name of ["project notes", "two  spaces", "tab\tname", "line\nbreak", "日本語", "x".repeat(64)]) {
  test(`compaction preserves named archives and resumes its counter: ${JSON.stringify(name)}`, async () => {
    const env = await testEnv();
    let agent = await Agent.create({ env, model: "p/m", contextId: "original", context: [USER("original")], createIO: reply });
    const stem = Array.from(name).slice(0, 62).join("");
    try {
      agent.context.rename(name);
      const oldFile = agent.context.file;
      const occupied = new Context({ id: `${stem}-1`, dir: env.settings.sessions, messages: [USER("occupied")] });
      occupied.flush();
      await occupied.close();
      await agent.compact();
      expect(agent.context.id).toBe(`${stem}-2`);
      expect(agent.context.name).toBe(`${stem}-2`);
      expect(agent.context.file).not.toBe(oldFile);
      const archived = Context.resume({ id: name, dir: env.settings.sessions });
      expect(archived.messages()).toEqual([USER("original")]);
      await archived.close();
      const id = agent.context.id;
      await agent.close();
      agent = await Agent.create({ env, model: "p/m", context: Context.resume({ id, dir: env.settings.sessions }), createIO: reply });
      await agent.compact();
      expect(agent.context.id).toBe(`${stem}-3`);
      expect(agent.context.name).toBe(`${stem}-3`);
      const untouched = Context.resume({ id: `${stem}-1`, dir: env.settings.sessions });
      expect(untouched.messages()).toEqual([USER("occupied")]);
      await untouched.close();
    } finally {
      await agent.close();
      await env.close();
    }
  });
}

for (const [id, name, expected] of [["project-cont-007", "project cont 007", "project-8"], [crypto.randomUUID(), "derived session name", "derived session name-1"], ["release-7", "release-7", "release-8"]]) {
  test(`compaction continues stored label ${name} as ${expected}`, async () => {
    const env = await testEnv();
    const context = new Context({ id, name, dir: env.settings.sessions, messages: [USER("original")] });
    const agent = await Agent.create({ env, model: "p/m", context, createIO: reply });
    try {
      await agent.compact();
      expect(agent.context.id).toBe(expected);
      expect(agent.context.name).toBe(expected);
      const archived = Context.resume({ id, dir: env.settings.sessions });
      expect(archived.messages()).toEqual([USER("original")]);
      await archived.close();
    } finally { await agent.close(); await env.close(); }
  });
}
