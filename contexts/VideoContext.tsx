import React, { createContext, useState, ReactNode } from 'react';
import { Video } from '@/types';
import { MOCK_VIDEOS } from '@/constants/mockData';

interface VideoContextType {
  videos: Video[];
  updateVideo: (id: string, updates: Partial<Video>) => void;
  addVideo: (video: Video) => void;
}

export const VideoContext = createContext<VideoContextType | undefined>(undefined);

export function VideoProvider({ children }: { children: ReactNode }) {
  const [videos, setVideos] = useState<Video[]>(MOCK_VIDEOS);

  const updateVideo = (id: string, updates: Partial<Video>) => {
    setVideos(prev =>
      prev.map(v => (v.id === id ? { ...v, ...updates } : v))
    );
  };

  const addVideo = (video: Video) => {
    setVideos(prev => [video, ...prev]);
  };

  return (
    <VideoContext.Provider value={{ videos, updateVideo, addVideo }}>
      {children}
    </VideoContext.Provider>
  );
}
