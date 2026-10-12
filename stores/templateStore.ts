import type { ReelTemplate, TemplateClip } from '@/types/template';

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

export function updateClipReplacement(
  clipId: string,
  uri: string,
  type: TemplateClip['replacementType'],
  aiPrompt?: string,
): void {
  if (!_activeTemplate) return;
  _activeTemplate = {
    ..._activeTemplate,
    clips: _activeTemplate.clips.map((c) =>
      c.id === clipId
        ? { ...c, replacementUri: uri, replacementType: type, aiGenerationPrompt: aiPrompt }
        : c,
    ),
  };
}

export function clearClipReplacement(clipId: string): void {
  if (!_activeTemplate) return;
  _activeTemplate = {
    ..._activeTemplate,
    clips: _activeTemplate.clips.map((c) =>
      c.id === clipId ? { ...c, replacementUri: undefined, replacementType: undefined } : c,
    ),
  };
}
