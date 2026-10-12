import { ReelTemplate } from '@/types';

/**
 * Lightweight in-memory store for the active reel template.
 * The template-picker sets it; template-editor (and any downstream screen) reads it.
 */
let _activeTemplate: ReelTemplate | null = null;

export function setActiveTemplate(template: ReelTemplate): void {
  _activeTemplate = template;
}

export function getActiveTemplate(): ReelTemplate | null {
  return _activeTemplate;
}

export function clearActiveTemplate(): void {
  _activeTemplate = null;
}
