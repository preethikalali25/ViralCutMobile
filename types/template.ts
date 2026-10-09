export interface TemplateClip {
  id: string;
  index: number;
  startTime: number;
  endTime: number;
  duration: number;
  description: string;
  textOverlay?: string;
  transitionType: 'cut' | 'fade' | 'dissolve' | 'slide';
  originalThumbnail: string; // base64 JPEG keyframe from source reel
  replacementUri?: string;
  replacementType?: 'photo' | 'video' | 'ai_generated';
  aiGenerationPrompt?: string;
}

export interface ReelTemplate {
  sourceVideoUri: string;
  totalDuration: number;
  clipCount: number;
  style: {
    vibe: string;
    pacing: 'fast' | 'medium' | 'slow';
    colorGrade: string;
    musicGenre: string;
    musicQuery: string;
  };
  clips: TemplateClip[];
}
