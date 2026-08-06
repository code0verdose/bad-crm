import { Agent, globalAgent, type AgentOptions } from 'node:http';

/**
 * Keep-alive off for every request this suite makes over TCP.
 *
 * supertest opens a fresh server on an ephemeral port for each `request(app)` — a hundred test files
 * make thousands of them in a run — and Node's global agent has kept sockets alive by default since
 * v19. So a pooled socket to `127.0.0.1:54321`, left over from a server that has since closed,
 * outlives it; the operating system hands the same port to the next server; and the next request is
 * written into a connection that belongs to nothing. What arrives back is not a status line, and the
 * parser says so: **«Parse Error: Expected HTTP/, RTSP/ or ICE/»**, on whichever unlucky test was
 * running — never the same one twice, which is exactly why it read as flakiness rather than as a
 * cause.
 *
 * Reproduced three times in this repository under `turbo run test`, in three unrelated files, and
 * never once when a file ran alone: the collision needs the port churn of four packages testing at
 * once. One connection per request costs microseconds on loopback and removes the class entirely.
 */
/**
 * Written through `options`, because that is where the agent keeps them: the constructor copies the
 * flag there, and the two are not aliases — assigning `agent.keepAlive` sets a property the socket
 * pool never reads. `@types/node` does not declare the field, hence the narrow cast rather than a
 * `@ts-expect-error` that would also hide the next mistake on this line.
 */
(globalAgent as Agent & { options: AgentOptions }).options.keepAlive = false;
globalAgent.maxSockets = Infinity;
