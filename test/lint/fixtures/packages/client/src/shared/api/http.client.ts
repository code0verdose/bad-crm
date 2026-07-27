export const request = async (path: string, init?: RequestInit): Promise<Response> =>
  fetch(path, init);
