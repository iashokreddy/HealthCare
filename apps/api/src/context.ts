import type { Config } from './config.js';
import type { Database } from './db/database.js';
import type { Keyring } from './lib/crypto.js';
import type { AuditService } from './services/audit.js';
import type { EventBus } from './services/events.js';
import type { TokenService } from './services/tokens.js';

export interface AppContext {
  cfg: Config;
  db: Database;
  ring: Keyring;
  tokens: TokenService;
  audit: AuditService;
  events: EventBus;
}
