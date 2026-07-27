import { readFile } from 'node:fs/promises';

export const load = (path: string): Promise<Buffer> => readFile(path);
