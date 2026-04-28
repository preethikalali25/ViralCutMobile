import { AlertProvider } from '@/template';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { Stack } from 'expo-router';
import { VideoProvider } from '@/contexts/VideoContext';

export default function RootLayout() {
  return (
    <AlertProvider>
      <SafeAreaProvider>
        <VideoProvider>
          <Stack screenOptions={{ headerShown: false }} />
        </VideoProvider>
      </SafeAreaProvider>
    </AlertProvider>
  );
}
