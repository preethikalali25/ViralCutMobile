import React, { useEffect, useState, useCallback } from 'react';
import {
  View, Text, StyleSheet, Pressable, ScrollView,
  ActivityIndicator, TextInput, Modal, KeyboardAvoidingView, Platform,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { MaterialIcons, MaterialCommunityIcons, FontAwesome5 } from '@expo/vector-icons';
import { useAuth, useAlert } from '@/template';
import { Colors, Spacing, Radius, FontSize, FontWeight } from '@/constants/theme';
import { useSocialAccounts } from '@/hooks/useSocialAccounts';

type PlatformMeta = {
  id: 'tiktok' | 'reels' | 'youtube';
  label: string;
  color: string;
  bgColor: string;
  icon: React.ReactNode;
  handlePrefix: string;
  placeholder: string;
};

const PLATFORMS: PlatformMeta[] = [
  {
    id: 'tiktok',
    label: 'TikTok',
    color: '#fff',
    bgColor: '#010101',
    icon: <MaterialCommunityIcons name="music-note" size={20} color="#fff" />,
    handlePrefix: '@',
    placeholder: '@yourchannel',
  },
  {
    id: 'reels',
    label: 'Instagram Reels',
    color: '#fff',
    bgColor: '#e1306c',
    icon: <MaterialCommunityIcons name="instagram" size={20} color="#fff" />,
    handlePrefix: '@',
    placeholder: '@yourprofile',
  },
  {
    id: 'youtube',
    label: 'YouTube Shorts',
    color: '#fff',
    bgColor: '#ff0000',
    icon: <MaterialCommunityIcons name="youtube" size={20} color="#fff" />,
    handlePrefix: '@',
    placeholder: '@yourchannel',
  },
];

function getInitials(email: string): string {
  const parts = email.split('@')[0].split(/[._-]/);
  return parts.slice(0, 2).map(p => p[0]?.toUpperCase() ?? '').join('') || email[0]?.toUpperCase() || 'U';
}

function formatFollowers(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

export default function ProfileScreen() {
  const router = useRouter();
  const { user, logout } = useAuth();
  const { showAlert } = useAlert();
  const { accounts, loading, load, connect, disconnect, getAccount } = useSocialAccounts();

  const [connectModal, setConnectModal] = useState<PlatformMeta | null>(null);
  const [handle, setHandle] = useState('');
  const [followers, setFollowers] = useState('');
  const [saving, setSaving] = useState(false);
  const [loggingOut, setLoggingOut] = useState(false);

  useEffect(() => {
    load();
  }, [load]);

  const handleLogout = async () => {
    showAlert('Sign Out', 'Are you sure you want to sign out?', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Sign Out',
        style: 'destructive',
        onPress: async () => {
          setLoggingOut(true);
          const { error } = await logout();
          if (error) {
            showAlert('Error', error);
            setLoggingOut(false);
          }
        },
      },
    ]);
  };

  const openConnect = (platform: PlatformMeta) => {
    const existing = getAccount(platform.id);
    setHandle(existing?.handle ?? '');
    setFollowers(existing ? String(existing.followers) : '');
    setConnectModal(platform);
  };

  const handleSaveConnect = async () => {
    if (!connectModal || !user) return;
    const trimmedHandle = handle.trim();
    if (!trimmedHandle) {
      showAlert('Missing Handle', 'Please enter your account handle.');
      return;
    }
    setSaving(true);
    const followersNum = parseInt(followers.replace(/[^0-9]/g, ''), 10) || 0;
    const { error } = await connect(user.id, connectModal.id, trimmedHandle, followersNum);
    setSaving(false);
    if (error) {
      showAlert('Error', error);
      return;
    }
    setConnectModal(null);
  };

  const handleDisconnect = (platform: PlatformMeta) => {
    const account = getAccount(platform.id);
    if (!account) return;
    showAlert(
      `Disconnect ${platform.label}?`,
      `Remove @${account.handle} from your ViralCut profile?`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Disconnect',
          style: 'destructive',
          onPress: async () => {
            const { error } = await disconnect(account.id);
            if (error) showAlert('Error', error);
          },
        },
      ]
    );
  };

  const initials = user?.email ? getInitials(user.email) : 'U';
  const memberSince = user?.created_at
    ? new Date(user.created_at).toLocaleDateString('en', { year: 'numeric', month: 'long' })
    : '';

  const totalFollowers = accounts.reduce((s, a) => s + (a.followers ?? 0), 0);

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      {/* Header */}
      <View style={styles.topBar}>
        <Pressable
          style={({ pressed }) => [styles.backBtn, pressed && { opacity: 0.7 }]}
          onPress={() => router.back()}
        >
          <MaterialIcons name="arrow-back" size={20} color={Colors.textPrimary} />
        </Pressable>
        <Text style={styles.topBarTitle}>Profile</Text>
        <View style={{ width: 36 }} />
      </View>

      <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={styles.content}>

        {/* Avatar + Info */}
        <View style={styles.avatarSection}>
          <View style={styles.avatarCircle}>
            <Text style={styles.avatarInitials}>{initials}</Text>
            <View style={styles.avatarGlow} />
          </View>
          <Text style={styles.emailText}>{user?.email ?? ''}</Text>
          {user?.username ? (
            <Text style={styles.usernameText}>@{user.username}</Text>
          ) : null}
          {memberSince ? (
            <View style={styles.memberRow}>
              <MaterialIcons name="calendar-today" size={12} color={Colors.textMuted} />
              <Text style={styles.memberText}>Member since {memberSince}</Text>
            </View>
          ) : null}
        </View>

        {/* Total reach pill */}
        {accounts.length > 0 ? (
          <View style={styles.reachPill}>
            <MaterialIcons name="people" size={16} color={Colors.primaryLight} />
            <Text style={styles.reachText}>
              {formatFollowers(totalFollowers)} total reach across {accounts.length} platform{accounts.length > 1 ? 's' : ''}
            </Text>
          </View>
        ) : null}

        {/* Connected Platforms */}
        <Text style={styles.sectionLabel}>Connected Platforms</Text>

        {loading ? (
          <ActivityIndicator color={Colors.primaryLight} style={{ marginVertical: 24 }} />
        ) : (
          <View style={styles.platformList}>
            {PLATFORMS.map(platform => {
              const account = getAccount(platform.id);
              const isConnected = !!account;

              return (
                <View key={platform.id} style={styles.platformCard}>
                  <View style={[styles.platformIcon, { backgroundColor: platform.bgColor }]}>
                    {platform.icon}
                  </View>

                  <View style={styles.platformInfo}>
                    <Text style={styles.platformLabel}>{platform.label}</Text>
                    {isConnected ? (
                      <View style={styles.connectedMeta}>
                        <Text style={styles.platformHandle}>{account.handle}</Text>
                        {account.followers > 0 ? (
                          <Text style={styles.platformFollowers}>
                            {formatFollowers(account.followers)} followers
                          </Text>
                        ) : null}
                      </View>
                    ) : (
                      <Text style={styles.notConnected}>Not connected</Text>
                    )}
                  </View>

                  <View style={styles.platformActions}>
                    {isConnected ? (
                      <>
                        <Pressable
                          style={({ pressed }) => [styles.editBtn, pressed && { opacity: 0.7 }]}
                          onPress={() => openConnect(platform)}
                        >
                          <MaterialIcons name="edit" size={14} color={Colors.primaryLight} />
                        </Pressable>
                        <Pressable
                          style={({ pressed }) => [styles.disconnectBtn, pressed && { opacity: 0.7 }]}
                          onPress={() => handleDisconnect(platform)}
                        >
                          <MaterialIcons name="link-off" size={14} color={Colors.error} />
                        </Pressable>
                      </>
                    ) : (
                      <Pressable
                        style={({ pressed }) => [styles.connectBtn, pressed && { opacity: 0.85 }]}
                        onPress={() => openConnect(platform)}
                      >
                        <MaterialIcons name="add-link" size={14} color="#fff" />
                        <Text style={styles.connectBtnText}>Connect</Text>
                      </Pressable>
                    )}
                  </View>
                </View>
              );
            })}
          </View>
        )}

        {/* Account Actions */}
        <Text style={styles.sectionLabel}>Account</Text>
        <View style={styles.accountCard}>
          <Pressable
            style={({ pressed }) => [styles.accountRow, pressed && { opacity: 0.7 }]}
            onPress={handleLogout}
            disabled={loggingOut}
          >
            {loggingOut ? (
              <ActivityIndicator size="small" color={Colors.error} />
            ) : (
              <MaterialIcons name="logout" size={18} color={Colors.error} />
            )}
            <Text style={styles.signOutText}>Sign Out</Text>
          </Pressable>
        </View>

        <View style={{ height: Spacing.xxl }} />
      </ScrollView>

      {/* Connect Modal */}
      <Modal
        visible={!!connectModal}
        animationType="slide"
        transparent
        onRequestClose={() => setConnectModal(null)}
      >
        <KeyboardAvoidingView
          style={styles.modalOverlay}
          behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        >
          <Pressable style={styles.modalBackdrop} onPress={() => setConnectModal(null)} />
          <View style={styles.modalSheet}>
            {connectModal ? (
              <>
                <View style={styles.modalHandle} />
                <View style={styles.modalHeader}>
                  <View style={[styles.modalIcon, { backgroundColor: connectModal.bgColor }]}>
                    {connectModal.icon}
                  </View>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.modalTitle}>Connect {connectModal.label}</Text>
                    <Text style={styles.modalSub}>Enter your account details</Text>
                  </View>
                  <Pressable onPress={() => setConnectModal(null)} hitSlop={8}>
                    <MaterialIcons name="close" size={20} color={Colors.textMuted} />
                  </Pressable>
                </View>

                <View style={styles.fieldGroup}>
                  <Text style={styles.fieldLabel}>Handle</Text>
                  <TextInput
                    style={styles.fieldInput}
                    value={handle}
                    onChangeText={setHandle}
                    placeholder={connectModal.placeholder}
                    placeholderTextColor={Colors.textMuted}
                    autoCapitalize="none"
                    autoCorrect={false}
                  />
                </View>

                <View style={styles.fieldGroup}>
                  <Text style={styles.fieldLabel}>Followers (optional)</Text>
                  <TextInput
                    style={styles.fieldInput}
                    value={followers}
                    onChangeText={setFollowers}
                    placeholder="e.g. 12500"
                    placeholderTextColor={Colors.textMuted}
                    keyboardType="numeric"
                  />
                </View>

                <Pressable
                  style={({ pressed }) => [styles.saveBtn, pressed && { opacity: 0.85 }]}
                  onPress={handleSaveConnect}
                  disabled={saving}
                >
                  {saving ? (
                    <ActivityIndicator color="#fff" size="small" />
                  ) : (
                    <Text style={styles.saveBtnText}>
                      {getAccount(connectModal.id) ? 'Update Account' : 'Connect Account'}
                    </Text>
                  )}
                </Pressable>
              </>
            ) : null}
          </View>
        </KeyboardAvoidingView>
      </Modal>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: Colors.background },
  topBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: Spacing.md,
    paddingVertical: Spacing.sm + 4,
    borderBottomWidth: 1,
    borderBottomColor: Colors.surfaceBorder,
  },
  backBtn: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: Colors.surfaceElevated,
    alignItems: 'center',
    justifyContent: 'center',
  },
  topBarTitle: {
    fontSize: FontSize.lg,
    fontWeight: FontWeight.bold,
    color: Colors.textPrimary,
    includeFontPadding: false,
  },
  content: {
    paddingHorizontal: Spacing.md,
    paddingTop: Spacing.xl,
  },

  // Avatar
  avatarSection: {
    alignItems: 'center',
    marginBottom: Spacing.lg,
  },
  avatarCircle: {
    width: 80,
    height: 80,
    borderRadius: 40,
    backgroundColor: Colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: Spacing.md,
    position: 'relative',
  },
  avatarGlow: {
    position: 'absolute',
    width: 80,
    height: 80,
    borderRadius: 40,
    backgroundColor: 'transparent',
    borderWidth: 2,
    borderColor: Colors.primaryLight + '60',
    transform: [{ scale: 1.2 }],
  },
  avatarInitials: {
    fontSize: FontSize.xxl,
    fontWeight: FontWeight.bold,
    color: '#fff',
    includeFontPadding: false,
  },
  emailText: {
    fontSize: FontSize.md,
    fontWeight: FontWeight.semibold,
    color: Colors.textPrimary,
    includeFontPadding: false,
  },
  usernameText: {
    fontSize: FontSize.sm,
    color: Colors.primaryLight,
    marginTop: 2,
    includeFontPadding: false,
  },
  memberRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    marginTop: Spacing.xs,
  },
  memberText: {
    fontSize: FontSize.xs,
    color: Colors.textMuted,
    includeFontPadding: false,
  },

  // Reach pill
  reachPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: Colors.primaryGlow,
    borderRadius: Radius.full,
    paddingHorizontal: Spacing.md,
    paddingVertical: 8,
    alignSelf: 'center',
    marginBottom: Spacing.lg,
    borderWidth: 1,
    borderColor: Colors.primary + '44',
  },
  reachText: {
    fontSize: FontSize.sm,
    color: Colors.primaryLight,
    fontWeight: FontWeight.semibold,
    includeFontPadding: false,
  },

  // Section
  sectionLabel: {
    fontSize: FontSize.xs,
    fontWeight: FontWeight.bold,
    color: Colors.textMuted,
    letterSpacing: 1,
    textTransform: 'uppercase',
    marginBottom: Spacing.sm,
    marginTop: Spacing.sm,
    includeFontPadding: false,
  },

  // Platform cards
  platformList: {
    gap: Spacing.sm,
    marginBottom: Spacing.lg,
  },
  platformCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.sm,
    backgroundColor: Colors.surfaceElevated,
    borderRadius: Radius.lg,
    padding: Spacing.md,
    borderWidth: 1,
    borderColor: Colors.surfaceBorder,
  },
  platformIcon: {
    width: 40,
    height: 40,
    borderRadius: Radius.sm,
    alignItems: 'center',
    justifyContent: 'center',
  },
  platformInfo: { flex: 1 },
  platformLabel: {
    fontSize: FontSize.sm,
    fontWeight: FontWeight.semibold,
    color: Colors.textPrimary,
    includeFontPadding: false,
  },
  connectedMeta: { gap: 2 },
  platformHandle: {
    fontSize: FontSize.sm,
    color: Colors.primaryLight,
    fontWeight: FontWeight.medium,
    includeFontPadding: false,
  },
  platformFollowers: {
    fontSize: FontSize.xs,
    color: Colors.textMuted,
    includeFontPadding: false,
  },
  notConnected: {
    fontSize: FontSize.xs,
    color: Colors.textMuted,
    marginTop: 2,
    includeFontPadding: false,
  },
  platformActions: {
    flexDirection: 'row',
    gap: 6,
    alignItems: 'center',
  },
  connectBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    backgroundColor: Colors.primary,
    borderRadius: Radius.full,
    paddingHorizontal: 12,
    paddingVertical: 6,
    minHeight: 32,
  },
  connectBtnText: {
    fontSize: FontSize.xs,
    fontWeight: FontWeight.bold,
    color: '#fff',
    includeFontPadding: false,
  },
  editBtn: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: Colors.primaryGlow,
    alignItems: 'center',
    justifyContent: 'center',
  },
  disconnectBtn: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: Colors.error + '18',
    alignItems: 'center',
    justifyContent: 'center',
  },

  // Account
  accountCard: {
    backgroundColor: Colors.surfaceElevated,
    borderRadius: Radius.lg,
    borderWidth: 1,
    borderColor: Colors.surfaceBorder,
    overflow: 'hidden',
    marginBottom: Spacing.lg,
  },
  accountRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.sm,
    padding: Spacing.md,
    minHeight: 52,
  },
  signOutText: {
    fontSize: FontSize.md,
    fontWeight: FontWeight.semibold,
    color: Colors.error,
    includeFontPadding: false,
  },

  // Modal
  modalOverlay: {
    flex: 1,
    justifyContent: 'flex-end',
  },
  modalBackdrop: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(0,0,0,0.6)',
  },
  modalSheet: {
    backgroundColor: Colors.surface,
    borderTopLeftRadius: Radius.xl,
    borderTopRightRadius: Radius.xl,
    padding: Spacing.lg,
    paddingBottom: Spacing.xxl,
    gap: Spacing.md,
    borderTopWidth: 1,
    borderColor: Colors.surfaceBorder,
  },
  modalHandle: {
    width: 36,
    height: 4,
    borderRadius: 2,
    backgroundColor: Colors.surfaceBorder,
    alignSelf: 'center',
    marginBottom: Spacing.xs,
  },
  modalHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.sm,
  },
  modalIcon: {
    width: 40,
    height: 40,
    borderRadius: Radius.sm,
    alignItems: 'center',
    justifyContent: 'center',
  },
  modalTitle: {
    fontSize: FontSize.lg,
    fontWeight: FontWeight.bold,
    color: Colors.textPrimary,
    includeFontPadding: false,
  },
  modalSub: {
    fontSize: FontSize.xs,
    color: Colors.textMuted,
    includeFontPadding: false,
  },
  fieldGroup: { gap: 6 },
  fieldLabel: {
    fontSize: FontSize.sm,
    fontWeight: FontWeight.semibold,
    color: Colors.textSecondary,
    includeFontPadding: false,
  },
  fieldInput: {
    backgroundColor: Colors.surfaceElevated,
    borderRadius: Radius.md,
    borderWidth: 1,
    borderColor: Colors.surfaceBorder,
    padding: Spacing.sm + 4,
    fontSize: FontSize.md,
    color: Colors.textPrimary,
    minHeight: 48,
    includeFontPadding: false,
  },
  saveBtn: {
    backgroundColor: Colors.primary,
    borderRadius: Radius.full,
    paddingVertical: 15,
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 50,
    marginTop: Spacing.xs,
  },
  saveBtnText: {
    fontSize: FontSize.md,
    fontWeight: FontWeight.bold,
    color: '#fff',
    includeFontPadding: false,
  },
});
