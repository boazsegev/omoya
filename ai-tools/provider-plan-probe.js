#!/usr/bin/env bun
/**
 * Authenticated provider plan-header probe.
 *
 * Usage: bun ai-tools/provider-plan-probe.js --endpoint <name> [--model <id>]
 * Reads the endpoint's stored credentials through Env, sends one tiny
 * non-streaming request, and prints only response headers plus the exact
 * planUsage payload the provider publishes. Never prints credentials/body.
 */
import { Env } from "../lib/env.js";

function usage() {
  console.log("provider-plan-probe — capture published plan/quota data\nusage: bun ai-tools/provider-plan-probe.js --endpoint <name> [--model <id>]\nI/O: stored Env auth -> one tiny API request -> safe headers + plan JSON. Never prints tokens or response body.");
}

const args = process.argv.slice(2);
if (args.includes("--help") || args.includes("-h")) { usage(); process.exit(0); }
const take = (name) => {
  const at = args.indexOf(name);
  return at >= 0 ? args[at + 1] : undefined;
};
const endpoint = take("--endpoint");
const requestedModel = take("--model");
if (!endpoint || args.some((arg) => !["--endpoint", "--model", endpoint, requestedModel].includes(arg))) {
  usage(); process.exit(1);
}

const env = await Env.create(undefined, { tools: false });
const settings = env.endpointSettings(endpoint);
if (!settings?.provider || !settings?.url || !settings?.auth?.token) {
  throw new Error(`endpoint ${JSON.stringify(endpoint)} needs provider, url, and stored auth`);
}
const Protocol = env.provider(settings.provider);
if (!Protocol) throw new Error(`unknown provider: ${settings.provider}`);
const models = settings.models && typeof settings.models === "object" ? Object.keys(settings.models) : [];
const model = requestedModel ?? models[0];
if (!model) throw new Error(`endpoint ${JSON.stringify(endpoint)} has no model; pass --model`);
const reports = [];
const aiio = {
  name: endpoint, url: settings.url, settings, modelCurrent: model,
  tools: () => [], planUsageSet: (report) => reports.push(report),
};
const connection = new Protocol(settings.url, aiio);
const [headers, body] = connection.context2msg([{ type: 2, content: [{ type: "text", text: "Reply with exactly: OK" }] }], aiio);
body.stream = false;
delete body.stream_options;
const response = await fetch(connection.url, { method: "POST", headers, body: JSON.stringify(body) });
const publishedHeaders = Object.fromEntries([...response.headers]
  .filter(([name]) => /^(?:anthropic-|x-ratelimit|ratelimit|x-usage|x-quota)/i.test(name)));
const output = { endpoint, provider: settings.provider, model, status: response.status, headers: publishedHeaders };
if (response.ok) {
  await connection.reportPlanUsage(response.headers, aiio);
  output.planUsage = reports.at(-1) ?? null;
  // Kimi Code exposes subscription windows at /usages, not chat headers.
  // Show the safe, relevant payload shape without the account/wallet data.
  if (endpoint === "kimi-coding" && output.planUsage === null) {
    const usageResponse = await fetch(`${settings.url.replace(/\/$/, "")}/usages`, {
      headers: { authorization: `Bearer ${settings.auth.token}` },
    });
    output.usageStatus = usageResponse.status;
    if (usageResponse.ok) {
      const usage = await usageResponse.json();
      output.usage = { usage: usage?.usage, limits: usage?.limits };
      await connection.reportPlanUsage(new Headers(), aiio);
      output.planUsage = reports.at(-1) ?? null;
    }
  }
} else {
  output.error = (await response.text()).slice(0, 500);
}
console.log(JSON.stringify(output, null, 2));
if (!response.ok) process.exitCode = 1;
