// Web stub for expo-modules-core
// Provides minimal no-op implementations to prevent bundling failures on web/SSR

export const NativeModulesProxy: Record<string, unknown> = {};
export const EventEmitter = class {
  addListener() { return { remove: () => {} }; }
  removeAllListeners() {}
  emit() {}
};
export const Platform = { OS: 'web' };
export const CodedError = class extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
};
export const UnavailabilityError = class extends Error {
  constructor(moduleName: string, propertyName: string) {
    super(`The method or property ${moduleName}.${propertyName} is not available on web.`);
  }
};
export function requireNativeModule(_name: string) { return {}; }
export function requireOptionalNativeModule(_name: string) { return null; }
export function registerWebModule(moduleClass: unknown) { return moduleClass; }
export const SharedObject = class {};
export const SharedRef = class {};
export const NativeModule = class {};
export default {};
