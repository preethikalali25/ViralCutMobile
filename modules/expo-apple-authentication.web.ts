// Web stub for expo-apple-authentication (iOS only)
export const AppleAuthenticationScope = {
  FULL_NAME: 0,
  EMAIL: 1,
};

export const AppleAuthenticationButtonType = {
  SIGN_IN: 0,
  CONTINUE: 1,
  SIGN_UP: 2,
};

export const AppleAuthenticationButtonStyle = {
  WHITE: 0,
  WHITE_OUTLINE: 1,
  BLACK: 2,
};

export async function isAvailableAsync(): Promise<boolean> {
  return false;
}

export async function signInAsync(_options?: unknown): Promise<never> {
  throw new Error('Apple Authentication is not available on this platform.');
}

export function AppleAuthenticationButton(_props: unknown): null {
  return null;
}

export default {
  AppleAuthenticationScope,
  AppleAuthenticationButtonType,
  AppleAuthenticationButtonStyle,
  isAvailableAsync,
  signInAsync,
  AppleAuthenticationButton,
};
