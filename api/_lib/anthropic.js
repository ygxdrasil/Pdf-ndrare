// @ts-check
// Leverantör: Claude (Anthropic). Tar emot appens begäran (Claude-format) och returnerar svaret oförändrat.
import Anthropic from '@anthropic-ai/sdk';

export const available = () => !!process.env.ANTHROPIC_API_KEY;

/** @param {any} req  @param {{hard:boolean}} opts */
export async function complete(req, opts) {
  const model = opts.hard ? 'claude-opus-5-5' : 'claude-sonnet-5-5';
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY, maxRetries: 2 });
  return client.messages.stream(/** @type {any} */ ({ ...req, model: process.env.CLAUDE_MODEL && opts.hard ? process.env.CLAUDE_MODEL : model })).finalMessage();
}
