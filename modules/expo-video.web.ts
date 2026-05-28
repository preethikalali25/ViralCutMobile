// Web stub — expo-video is not supported on web
import { useRef } from 'react';
import { View } from 'react-native';

export function useVideoPlayer(_source: any, _setup?: (player: any) => void): any {
  return useRef({
    play: () => {},
    pause: () => {},
    loop: false,
  }).current;
}

export const VideoView = View;
