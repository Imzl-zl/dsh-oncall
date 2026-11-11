/**
 * The subagent-chat resource address, mirrored from DSH's own provider.
 *
 * DSH owns this format in `ui-subagent/src/client/sidebar-chat/index.tsx:51-57`
 * (`subagentChatAddress`), but the package does not re-export it from its public
 * `./client` entry, and importing the internal module would inline the whole
 * chat UI into this bundle. The format is a public resource contract: the
 * provider parses `dsh-resource://subagentchat/session/<child>?parent=<parent>&mode=<mode>`.
 * Keeping the six-line builder here is the smallest honest adapter; the test
 * pins it to the native fixture from `ui-subagent/tests/sidebar-chat.client.spec.tsx:37`.
 *
 * Note: 为何镜像而不是 import 原生 helper —— 见 docs/design/agent-fleet-drawer.md §9.3
 */

import type { SubagentAddress } from '@deepseek-ai/dsh-subagent/client'

/** The address prefix the `subagentchat` resource provider owns. */
export const SUBAGENT_CHAT_ADDRESS = 'dsh-resource://subagentchat/session/'

/**
 * Address one durable direct-parent subagent conversation for the right sidebar.
 * @param address - the child's durable parent/child/mode triple.
 * @returns the canonical resource address the `subagentchat` provider accepts.
 */
export function subagentChatAddress(address: SubagentAddress): string {
  const query = new URLSearchParams({
    parent: address.parentSessionId,
    mode: address.mode,
  })
  return `${SUBAGENT_CHAT_ADDRESS}${encodeURIComponent(address.childSessionId)}?${query}`
}
