export const useLogin = async (): Promise<Response> => fetch('/api/v1/auth/login');
