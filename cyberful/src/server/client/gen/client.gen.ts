// ── Default Control-Plane Client ──────────────────────────────
// Creates the default Fetch client configured for Cyberful's local control-plane
// base URL and exposes the configuration override used by SDK consumers.
// → cyberful/script/generate-client.ts — regenerates and patches this module.
// ─────────────────────────────────────────────────────────────────

import { createClient } from './client/client.gen';
import type { ClientOptions, Config } from './client/types.gen';
import { createConfig } from './client/utils.gen';
import type { ClientOptions as ClientOptions2 } from './types.gen';

/**
 * The `createClientConfig()` function will be called on client initialization
 * and the returned object will become the client's initial configuration.
 *
 * You may want to initialize your client this way instead of calling
 * `setConfig()`. This is useful for example if you're using Next.js
 * to ensure your client always has the correct values.
 */
export type CreateClientConfig<T extends ClientOptions = ClientOptions2> = (override?: Config<ClientOptions & T>) => Config<Required<ClientOptions> & T>;

export const client = createClient(createConfig<ClientOptions2>({ baseUrl: 'http://localhost:4096' }));
