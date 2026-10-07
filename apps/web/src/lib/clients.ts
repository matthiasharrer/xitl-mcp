import type { McpClient } from './api';

/** How a client got access: OAuth, or a token for one or all upstreams. */
export const clientKind = (c: McpClient) =>
  c.kind === 'TOKEN' ? (c.allUpstreams ? 'Token für alle Upstreams' : `Token für ${c.upstream?.name ?? 'Upstream'}`) : 'OAuth';
