#!/usr/bin/env bun
// Declarative static-site build: config + data + Mustache templates + Markdown -> out dir.
const HELP = `Usage: bun build.js [config=site.json]
Deps: bun add marked mustache. Side effect: deletes and recreates build.out.
Config: { build: { out, copy[], partials?, pages[] }, data: {...} }
  page: { template, out, data?, each?, escape? }  out is a Mustache pattern;
  each names a data array -> one file per item (item merged into the view).
Data: "<key>-src-<md|html|txt|json>": "path" is replaced by "<key>": loaded file
  (md rendered, json resolved recursively; paths relative to the referencing file).
Derived: arrays of objects get index, number, first, last; each array key gets has_<key>;
  view gets build_date, build_year. Escape by out extension: html/xml/svg escaped, else none.`;

import {readFileSync, writeFileSync, mkdirSync, rmSync, cpSync, readdirSync, existsSync} from 'node:fs';
import {dirname, join, resolve, relative, parse, extname, isAbsolute} from 'node:path';
import {Marked} from 'marked';
import Mustache from 'mustache';

const md = new Marked({gfm: true});
md.use({renderer: {link(token) {  // external links open in a new tab
  const html = Object.getPrototypeOf(this).link.call(this, token);
  return /^https?:\/\//.test(token.href) ? html.replace('<a ', '<a target="_blank" rel="noopener noreferrer" ') : html;
}}});

const LOADERS = {md: s => md.parse(s), html: s => s, txt: s => s, json: s => JSON.parse(s)};
const XML = s => String(s).replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`);
const ESCAPES = {html: XML, htm: XML, xml: XML, svg: XML, none: s => String(s)};
const read = file => readFileSync(file, 'utf8');

// Replace "<key>-src-<type>" references with loaded content; decorate arrays for logic-less templates.
function resolveData(node, baseDir) {
  if (Array.isArray(node)) {
    node.forEach((item, i) => {
      resolveData(item, baseDir);
      if (item && typeof item === 'object' && !Array.isArray(item))
        Object.assign(item, {index: i, number: i + 1, first: i === 0, last: i === node.length - 1}, {...item});
    });
  } else if (node && typeof node === 'object') {
    for (const [key, value] of Object.entries(node)) {
      const ref = key.match(/^(.+)-src-(\w+)$/);
      if (ref && typeof value === 'string') {
        const loader = LOADERS[ref[2]];
        if (!loader) throw new Error(`Unknown source type "${ref[2]}" in ${key}`);
        const file = resolve(baseDir, value);
        delete node[key];
        node[ref[1]] = loader(read(file));
        if (ref[2] === 'json') resolveData(node[ref[1]], dirname(file));
      } else resolveData(value, baseDir);
    }
    for (const [key, value] of Object.entries(node))
      if (Array.isArray(value)) node[`has_${key}`] ??= value.length > 0;
  }
  return node;
}

function inside(root, target) {
  const rel = relative(root, target);
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) throw new Error(`Path escapes ${root}: ${target}`);
  return target;
}

function loadPartials(dir) {
  if (!dir) return {};
  return Object.fromEntries(readdirSync(dir).filter(f => !f.startsWith('.')).map(f => [parse(f).name, read(join(dir, f))]));
}

function build(configPath) {
  const started = performance.now();
  const root = dirname(resolve(configPath));
  const {build: cfg, data = {}} = JSON.parse(read(configPath));
  if (!cfg?.out || !Array.isArray(cfg.pages)) throw new Error('Config needs build.out and build.pages[]');

  const now = new Date();
  const shared = resolveData({...data, build_date: now.toLocaleDateString('sv-SE'), build_year: String(now.getFullYear())}, root);
  const partials = loadPartials(cfg.partials && join(root, cfg.partials));
  const out = inside(root, resolve(root, cfg.out));

  const files = [];  // render everything before touching the previous output
  for (const page of cfg.pages) {
    const template = read(join(root, page.template));
    const view = {...shared, ...resolveData(structuredClone(page.data ?? {}), root)};
    const items = page.each ? view[page.each] : [{}];
    if (!Array.isArray(items)) throw new Error(`each: "${page.each}" is not an array`);
    for (const item of items) {
      const itemView = {...view, ...item};
      const file = inside(out, resolve(out, Mustache.render(page.out, itemView)));
      const escape = ESCAPES[page.escape ?? extname(file).slice(1)] ?? ESCAPES.none;
      files.push([file, Mustache.render(template, itemView, partials, {escape})]);
    }
  }

  rmSync(out, {recursive: true, force: true});
  mkdirSync(out, {recursive: true});
  for (const dir of cfg.copy ?? [])
    if (existsSync(join(root, dir))) cpSync(join(root, dir), join(out, dir), {recursive: true});
  for (const [file, text] of files) {
    mkdirSync(dirname(file), {recursive: true});
    writeFileSync(file, text);
    console.log(`  ${relative(root, file)}`);
  }
  console.log(`Built ${files.length} file(s) in ${(performance.now() - started).toFixed(0)} ms -> ${relative(root, out)}/`);
}

if (process.argv.includes('--help')) console.log(HELP);
else build(process.argv[2] ?? 'site.json');
