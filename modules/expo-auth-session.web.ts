// Web stub for expo-auth-session
// Prevents nested expo-constants resolution issues in SSR/web bundling

export const useAuthRequest = () => [null, null, () => {}];
export const useAutoDiscovery = () => null;
export const makeRedirectUri = (_opts?: Record<string, unknown>) => '';
export const AuthRequest = class {};
export const AuthSessionResult = {};
export const ResponseType = { Code: 'code', Token: 'token' };
export const CodeChallengeMethod = { S256: 'S256', Plain: 'plain' };
export const Prompt = { Login: 'login', Consent: 'consent' };

export default {
  useAuthRequest,
  useAutoDiscovery,
  makeRedirectUri,
  AuthRequest,
  ResponseType,
  CodeChallengeMethod,
  Prompt,
};
