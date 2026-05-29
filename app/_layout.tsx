import { AlertProvider, AuthProvider } from '@/template';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { Stack } from 'expo-router';
import { VideoProvider } from '@/contexts/VideoContext';
import { useEffect } from 'react';
import { Audio } from 'expo-av';

function AudioSessionInit() {
  useEffect(() => {
    // Set audio session to .playback so video audio plays even when
    // the physical mute switch is on (same as music/podcast apps).
    Audio.setAudioModeAsync({ playsInSilentModeIOS: true }).catch(() => {});
  }, []);
  return null;
}

export default function RootLayout() {
  return (
    <AlertProvider>
      <SafeAreaProvider>
        <AuthProvider>
          <VideoProvider>
            <AudioSessionInit />
            <Stack screenOptions={{ headerShown: false }}>
              <Stack.Screen name="index" options={{ headerShown: false }} />
              <Stack.Screen name="login" options={{ headerShown: false }} />
              <Stack.Screen name="profile" options={{ headerShown: false }} />
            </Stack>
          </VideoProvider>
        </AuthProvider>
      </SafeAreaProvider>
    </AlertProvider>
  );
}
