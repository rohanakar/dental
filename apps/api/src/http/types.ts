import type { Logger } from 'pino';
import type { AuthContext } from '../ports/auth';

export interface AppEnv {
  Variables: {
    auth: AuthContext;
    log: Logger;
    requestId: string;
  };
}
