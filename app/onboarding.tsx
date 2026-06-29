import React, { useState } from 'react';
import {
  View, Text, StyleSheet, Pressable, ActivityIndicator, ScrollView,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { MaterialCommunityIcons, MaterialIcons } from '@expo/vector-icons';
import { Colors, Spacing, Radius, FontSize, FontWeight } from '@/constants/theme';
import { useInstagram } from '@/hooks/useInstagram';
import { useTikTok } from '@/hooks/useTikTok';
import { useYouTube } from '@/hooks/useYouTube';
import { useAlert } from '@/template';
import AsyncStorage from '@react-native-async-storage/async-storage';

const ONBOARDING_KEY = 'shortreel_onboarding_done';

export async function markOnboardingDone() {
  await AsyncStorage.setItem(ONBOARDING_KEY, '1');
}

export async function hasCompletedOnboarding(): Promise<boolean> {
  return (await AsyncStorage.getItem(ONBOARDING_KEY)) === '1';
}

export default function OnboardingScreen() {
  const router = useRouter();
  const { showAlert } = useAlert();
  const instagram = useInstagram();
  const tiktok = useTikTok();
  const youtube = useYouTube();

  const [connecting, setConnecting] = useState<'instagram' | 'tiktok' | 'youtube' | null>(null);

  const handleConnect = async (platform: 'instagram' | 'tiktok' | 'youtube') => {
    setConnecting(platform);
    let result: { error?: string } = {};
    if (platform === 'instagram') result = await instagram.connect();
    else if (platform === 'tiktok') result = await tiktok.connect();
    else result = await youtube.connect();
    setConnecting(null);
    if (result.error && result.error !== 'OAuth cancelled') {
      showAlert('Connection Failed', result.error);
    }
  };

  const handleFinish = async () => {
    await markOnboardingDone();
    router.replace('/(tabs)');
  };

  const anyConnected = instagram.status.connected || tiktok.status.connected || youtube.status.connected;

  const platforms = [
    {
      id: 'instagram' as const,
      label: 'Instagram',
      sub: 'Connect to schedule & publish Reels',
      icon: 'instagram',
      color: '#e1306c',
      connected: instagram.status.connected,
      username: instagram.status.username,
    },
    {
      id: 'tiktok' as const,
      label: 'TikTok',
      sub: 'Connect to schedule & publish videos',
      icon: 'music-note',
      color: '#ee1d52',
      connected: tiktok.status.connected,
      username: tiktok.status.creatorName,
    },
    {
      id: 'youtube' as const,
      label: 'YouTube',
      sub: 'Connect to publish Shorts',
      icon: 'youtube',
      color: '#ff0000',
      connected: youtube.status.connected,
      username: youtube.status.channelTitle,
    },
  ];

  return (
    <SafeAreaView style={styles.safe}>
      <ScrollView contentContainerStyle={styles.scroll} showsVerticalScrollIndicator={false}>
        <View style={styles.heroIcon}>
          <MaterialIcons name="link" size={36} color={Colors.primaryLight} />
        </View>
        <Text style={styles.title}>Connect Your Accounts</Text>
        <Text style={styles.sub}>
          Link your social accounts so ShortReel can schedule and publish your videos automatically.
        </Text>

        <View style={styles.cards}>
          {platforms.map(p => (
            <View key={p.id} style={[styles.card, p.connected && { borderColor: p.color }]}>
              <View style={[styles.cardIcon, { backgroundColor: p.color + '22' }]}>
                <MaterialCommunityIcons name={p.icon as any} size={26} color={p.color} />
              </View>
              <View style={styles.cardInfo}>
                <Text style={styles.cardLabel}>{p.label}</Text>
                {p.connected && p.username ? (
                  <Text style={[styles.cardSub, { color: p.color }]}>@{p.username}</Text>
                ) : (
                  <Text style={styles.cardSub}>{p.sub}</Text>
                )}
              </View>
              {p.connected ? (
                <View style={[styles.connectedBadge, { backgroundColor: p.color + '22' }]}>
                  <MaterialIcons name="check-circle" size={18} color={p.color} />
                  <Text style={[styles.connectedText, { color: p.color }]}>Connected</Text>
                </View>
              ) : (
                <Pressable
                  style={({ pressed }) => [
                    styles.connectBtn,
                    { borderColor: p.color },
                    pressed && { opacity: 0.75 },
                    connecting === p.id && { opacity: 0.6 },
                  ]}
                  onPress={() => handleConnect(p.id)}
                  disabled={!!connecting}
                >
                  {connecting === p.id ? (
                    <ActivityIndicator size="small" color={p.color} />
                  ) : (
                    <Text style={[styles.connectBtnText, { color: p.color }]}>Connect</Text>
                  )}
                </Pressable>
              )}
            </View>
          ))}
        </View>

        <Pressable
          style={({ pressed }) => [styles.continueBtn, pressed && { opacity: 0.85 }]}
          onPress={handleFinish}
        >
          <Text style={styles.continueBtnText}>
            {anyConnected ? 'Continue to ShortReel' : 'Skip for now'}
          </Text>
          <MaterialIcons name="arrow-forward" size={18} color="#fff" />
        </Pressable>

        {!anyConnected && (
          <Text style={styles.skipNote}>
            You can connect accounts anytime from Settings.
          </Text>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: Colors.background },
  scroll: { padding: Spacing.lg, alignItems: 'center' },
  heroIcon: {
    width: 72, height: 72, borderRadius: 36,
    backgroundColor: Colors.primary + '22',
    alignItems: 'center', justifyContent: 'center',
    marginTop: Spacing.xl, marginBottom: Spacing.md,
  },
  title: {
    fontSize: FontSize.xl, fontWeight: FontWeight.bold,
    color: Colors.text, textAlign: 'center', marginBottom: Spacing.sm,
  },
  sub: {
    fontSize: FontSize.sm, color: Colors.textSecondary,
    textAlign: 'center', lineHeight: 20,
    marginBottom: Spacing.xl, maxWidth: 300,
  },
  cards: { width: '100%', gap: Spacing.sm, marginBottom: Spacing.xl },
  card: {
    flexDirection: 'row', alignItems: 'center', gap: Spacing.sm,
    backgroundColor: Colors.surface, borderRadius: Radius.md,
    borderWidth: 1, borderColor: Colors.surfaceBorder,
    padding: Spacing.md,
  },
  cardIcon: {
    width: 46, height: 46, borderRadius: Radius.sm,
    alignItems: 'center', justifyContent: 'center',
  },
  cardInfo: { flex: 1 },
  cardLabel: { fontSize: FontSize.md, fontWeight: FontWeight.semibold, color: Colors.text },
  cardSub: { fontSize: FontSize.xs, color: Colors.textMuted, marginTop: 2 },
  connectedBadge: {
    flexDirection: 'row', alignItems: 'center', gap: 4,
    borderRadius: Radius.sm, paddingHorizontal: Spacing.sm, paddingVertical: 4,
  },
  connectedText: { fontSize: FontSize.xs, fontWeight: FontWeight.semibold },
  connectBtn: {
    borderWidth: 1.5, borderRadius: Radius.sm,
    paddingHorizontal: Spacing.sm, paddingVertical: 6,
    minWidth: 76, alignItems: 'center', justifyContent: 'center', minHeight: 32,
  },
  connectBtnText: { fontSize: FontSize.sm, fontWeight: FontWeight.semibold },
  continueBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    gap: Spacing.xs, backgroundColor: Colors.primary,
    borderRadius: Radius.md, paddingVertical: Spacing.md,
    width: '100%', marginBottom: Spacing.sm,
  },
  continueBtnText: { fontSize: FontSize.md, fontWeight: FontWeight.semibold, color: '#fff' },
  skipNote: { fontSize: FontSize.xs, color: Colors.textMuted, textAlign: 'center' },
});
