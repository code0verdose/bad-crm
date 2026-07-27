/**
 * Entry point of the API process.
 *
 * Three lines by design. The composition root itself lives in
 * `infrastructure/bootstrap/api-process.factory.ts`, where the startup sequence — validate the
 * environment, build the logger, create the infrastructure clients, assemble the container, open
 * the port — is expressed with injectable seams and is therefore covered by tests. Code that only
 * exists in a module executed by `node dist/main.js` is code no test can reach, and the startup
 * order is exactly the part that must not regress: it is what guarantees a misconfigured
 * installation refuses to start instead of accepting requests it cannot serve.
 */
import { startApiProcess } from '@/infrastructure/bootstrap/api-process.factory.js';

await startApiProcess();
