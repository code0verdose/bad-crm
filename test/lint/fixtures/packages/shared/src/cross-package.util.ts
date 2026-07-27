// `shared` is the bottom of the dependency graph and may not reach into an application package.
import { createServer } from '@bad-crm/server';

export const boot = (): unknown => createServer();
