/** Shared display-only publication snapshot for the TUI and Web inspectors. */

/**
 * Render provider-neutral tool descriptors, never execution metadata.
 * @param {Map<string, object>} tools Current Agent.tools snapshot.
 * @returns {string} Markdown sections with each tool's name, description and full published descriptor/schema; not conversation content.
 */
export function toolCatalogText(tools) {
  const intro = `# Published tools (${tools.size})\n\nThe following tools are published to this agent for use in the conversation.\n\nCurrent model-facing catalog, before provider-specific conversion; not a historical request capture. This virtual system block is read-only and is not stored or sent as a conversation message.`;
  const sections = [...tools].map(([name, descriptor]) => {
    const description = descriptor.description ? `${descriptor.description}\n\n` : "";
    return `## \`${name}\`\n\n${description}\`\`\`json\n${JSON.stringify(descriptor, null, 2)}\n\`\`\``;
  });
  return `${intro}\n\n${sections.length ? sections.join("\n\n") : "No tools are currently published to this agent."}`;
}
