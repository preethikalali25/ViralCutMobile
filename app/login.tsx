// Universal fallback — on iOS/Android, Metro resolves login.native.tsx instead.
// On web, login.web.tsx is preferred. This file satisfies Expo Router's requirement
// that every platform-specific file has a non-platform fallback sibling.
export { default } from './login.web';
