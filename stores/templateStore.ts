import type { ReelTemplate } from '@/types/template';

let activeTemplate: ReelTemplate | null = null;

export function setActiveTemplate(t: ReelTemplate): void {
  activeTemplate = t;
}

export function getActiveTemplate(): ReelTemplate | null {
  return activeTemplate;
}

export function clearActiveTemplate(): void {
  activeTemplate = null;
}

export function updateClipReplacement(
  clipId: string,
  uri: string,
  type: 'photo' | 'video' | 'ai_generated',
  aiPrompt?: string,
): void {
  if (!activeTemplate) return;
  activeTemplate = {
    ...activeTemplate,
    clips: activeTemplate.clips.map((c) =>
      c.id === clipId
        ? { ...c, replacementUri: uri, replacementType: type, aiGenerationPrompt: aiPrompt }
        : c
    ),
  };
}

export function clearClipReplacement(clipId: string): void {
  if (!activeTemplate) return;
  activeTemplate = {
    ...activeTemplate,
    clips: activeTemplate.clips.map((c) =>
      c.id === clipId
        ? { ...c, replacementUri: undefined, replacementType: undefined, aiGenerationPrompt: undefined }
        : c
    ),
  };
}
