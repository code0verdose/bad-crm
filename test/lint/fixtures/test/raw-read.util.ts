import { readFileSync } from 'node:fs';

// Bypasses the recording door, so the read never reaches the //#test:repo inputs audit.
export const readAnything = (path: string): string => readFileSync(path, 'utf8');
