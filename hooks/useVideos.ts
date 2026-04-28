import { useContext } from 'react';
import { VideoContext } from '@/contexts/VideoContext';

export function useVideos() {
  const context = useContext(VideoContext);
  if (!context) throw new Error('useVideos must be used within VideoProvider');
  return context;
}
