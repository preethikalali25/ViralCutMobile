import React, { useState, useEffect } from 'react';
import {
  View, Text, StyleSheet, Pressable, TextInput,
  KeyboardAvoidingView, Platform, ScrollView, ActivityIndicator,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Image } from 'expo-image';
import { MaterialIcons, MaterialCommunityIcons } from '@expo/vector-icons';
import * as AppleAuthentication from 'expo-apple-authentication';
import { useAuth, useAlert } from '@/template';
import { getSharedSupabaseClient } from '@/template/core/client';
import { Colors, Spacing, Radius, FontSize, FontWeight } from '@/constants/theme';
import { useRouter } from 'expo-router';

type Mode = 'landing' | 'email' | 'otp';

export default function LoginScreen() {
  const { signInWithGoogle, operationLoading, user } = useAuth();
  const { showAlert } = useAlert();
  const router = useRouter();

  useEffect(() => {
    if (user) {
      router.replace('/');
    }
  }, [user]);

  const [mode, setMode] = useState<Mode>('landing');
  const [email, setEmail] = useState('');
  const [otp, setOtp] = useState('');
  const [loading, setLoading] = useState(false);;

  const isBusy = operationLoading || loading;

  const handleGoogle = async () => {
    const { error } = await signInWithGoogle();
    if (error) showAlert('Google Sign-In Failed', error);
  };

  const handleApple = async () => {
    try {
      const credential = await AppleAuthentication.signInAsync({
        requestedScopes: [
          AppleAuthentication.AppleAuthenticationScope.FULL_NAME,
          AppleAuthentication.AppleAuthenticationScope.EMAIL,
        ],
      });
      setLoading(true);
      const supabase = getSharedSupabaseClient();
      const { error } = await supabase.auth.signInWithIdToken({
        provider: 'apple',
        token: credential.identityToken!,
      });
      if (error) showAlert('Apple Sign-In Failed', error.message);
    } catch (e: any) {
      if (e?.code !== 'ERR_REQUEST_CANCELED') {
        showAlert('Apple Sign-In Failed', e?.message ?? 'Unknown error');
      }
    } finally {
      setLoading(false);
    }
  };

  const handleSendOTP = async () => {
    if (!email.trim()) {
      showAlert('Enter Email', 'Please enter your email address.');
      return;
    }
    setLoading(true);
    try {
      const supabase = getSharedSupabaseClient();
      const { error } = await supabase.auth.signInWithOtp({
        email: email.trim(),
        options: { shouldCreateUser: true },
      });
      if (error) {
        showAlert('Failed to Send Code', error.message);
      } else {
        setOtp('');
        setMode('otp');
      }
    } finally {
      setLoading(false);
    }
  };

  const handleVerifyOTP = async () => {
    if (!otp.trim()) {
      showAlert('Enter Code', 'Please enter the verification code from your email.');
      return;
    }
    setLoading(true);
    try {
      const supabase = getSharedSupabaseClient();
      const { error } = await supabase.auth.verifyOtp({
        email: email.trim(),
        token: otp.trim(),
        type: 'email',
      });
      if (error) showAlert('Verification Failed', error.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <SafeAreaView style={styles.safe}>
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : 'height'}>
        <ScrollView contentContainerStyle={styles.scrollContent} showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled">

          {/* Hero */}
          <View style={styles.heroWrapper}>
            <Image
              source={require('@/assets/images/login-bg.png')}
              style={styles.heroImage}
              contentFit="cover"
              transition={300}
            />
            <View style={styles.heroOverlay}>
              <MaterialCommunityIcons name="scissors-cutting" size={32} color={Colors.primaryLight} />
              <Text style={styles.heroTitle}>SmartReel</Text>
              <Text style={styles.heroSub}>Your short-form video studio</Text>
            </View>
          </View>

          {/* Card */}
          <View style={styles.card}>

            {/* ── Landing ── */}
            {mode === 'landing' && (
              <>
                <Text style={styles.cardTitle}>Get Started</Text>
                <Text style={styles.cardSub}>Sign in or create an account</Text>

                {/* Apple — always rendered on iOS; isAvailableAsync guards the flow not the render */}
                {Platform.OS === 'ios' && (
                  <AppleAuthentication.AppleAuthenticationButton
                    buttonType={AppleAuthentication.AppleAuthenticationButtonType.SIGN_IN}
                    buttonStyle={AppleAuthentication.AppleAuthenticationButtonStyle.WHITE}
                    cornerRadius={50}
                    style={styles.appleBtn}
                    onPress={handleApple}
                  />
                )}

                {/* Google */}
                <Pressable
                  style={({ pressed }) => [styles.socialBtn, pressed && { opacity: 0.85 }]}
                  onPress={handleGoogle}
                  disabled={isBusy}
                >
                  {isBusy ? (
                    <ActivityIndicator color={Colors.textPrimary} size="small" />
                  ) : (
                    <>
                      <MaterialCommunityIcons name="google" size={20} color="#EA4335" />
                      <Text style={styles.socialBtnText}>Continue with Google</Text>
                    </>
                  )}
                </Pressable>

                {/* Divider */}
                <View style={styles.divider}>
                  <View style={styles.dividerLine} />
                  <Text style={styles.dividerText}>or</Text>
                  <View style={styles.dividerLine} />
                </View>

                {/* Email OTP */}
                <Pressable
                  style={({ pressed }) => [styles.emailBtn, pressed && { opacity: 0.85 }]}
                  onPress={() => setMode('email')}
                >
                  <MaterialIcons name="email" size={18} color={Colors.textSecondary} />
                  <Text style={styles.emailBtnText}>Continue with Email</Text>
                </Pressable>
              </>
            )}

            {/* ── Email entry ── */}
            {mode === 'email' && (
              <>
                <Pressable style={styles.backRow} onPress={() => setMode('landing')}>
                  <MaterialIcons name="arrow-back" size={16} color={Colors.textSecondary} />
                  <Text style={styles.backText}>Back</Text>
                </Pressable>

                <Text style={styles.cardTitle}>Enter Your Email</Text>
                <Text style={styles.cardSub}>
                  We'll send a 4-digit code to sign you in or create your account — no password needed.
                </Text>

                <View style={styles.inputGroup}>
                  <Text style={styles.inputLabel}>Email</Text>
                  <TextInput
                    style={styles.input}
                    value={email}
                    onChangeText={setEmail}
                    placeholder="you@example.com"
                    placeholderTextColor={Colors.textMuted}
                    keyboardType="email-address"
                    autoCapitalize="none"
                    autoComplete="email"
                    autoFocus
                  />
                </View>

                <Pressable
                  style={({ pressed }) => [styles.primaryBtn, pressed && { opacity: 0.85 }]}
                  onPress={handleSendOTP}
                  disabled={isBusy}
                >
                  {isBusy ? (
                    <ActivityIndicator color="#fff" size="small" />
                  ) : (
                    <Text style={styles.primaryBtnText}>Send Code</Text>
                  )}
                </Pressable>
              </>
            )}

            {/* ── OTP verify ── */}
            {mode === 'otp' && (
              <>
                <View style={styles.otpIcon}>
                  <MaterialIcons name="mark-email-read" size={32} color={Colors.primaryLight} />
                </View>
                <Text style={styles.cardTitle}>Check Your Email</Text>
                <Text style={styles.cardSub}>
                  We sent a 4-digit code to{'\n'}
                  <Text style={{ color: Colors.primaryLight }}>{email}</Text>
                </Text>

                <View style={styles.inputGroup}>
                  <Text style={styles.inputLabel}>Verification Code</Text>
                  <TextInput
                    style={[styles.input, styles.otpInput]}
                    value={otp}
                    onChangeText={setOtp}
                    placeholder="••••"
                    placeholderTextColor={Colors.textMuted}
                    keyboardType="number-pad"
                    maxLength={4}
                    autoFocus
                  />
                </View>

                <Pressable
                  style={({ pressed }) => [styles.primaryBtn, pressed && { opacity: 0.85 }]}
                  onPress={handleVerifyOTP}
                  disabled={isBusy}
                >
                  {isBusy ? (
                    <ActivityIndicator color="#fff" size="small" />
                  ) : (
                    <Text style={styles.primaryBtnText}>Verify & Continue</Text>
                  )}
                </Pressable>

                <Pressable
                  onPress={handleSendOTP}
                  disabled={isBusy}
                >
                  <Text style={styles.switchText}>
                    Didn't get it? <Text style={styles.switchLink}>Resend code</Text>
                  </Text>
                </Pressable>

                <Pressable onPress={() => setMode('email')}>
                  <Text style={styles.switchText}>
                    <Text style={styles.switchLink}>← Change email</Text>
                  </Text>
                </Pressable>
              </>
            )}

          </View>

          <Text style={styles.footer}>
            By continuing you agree to our Terms & Privacy Policy
          </Text>

        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: Colors.background },
  scrollContent: {
    flexGrow: 1,
    paddingBottom: Spacing.xl,
  },
  heroWrapper: {
    height: 260,
    position: 'relative',
    overflow: 'hidden',
  },
  heroImage: {
    width: '100%',
    height: '100%',
  },
  heroOverlay: {
    position: 'absolute',
    top: 0, left: 0, right: 0, bottom: 0,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(8,10,20,0.5)',
    gap: 6,
  },
  heroTitle: {
    fontSize: FontSize.xxxl,
    fontWeight: FontWeight.extrabold,
    color: Colors.textPrimary,
    letterSpacing: 1.5,
    includeFontPadding: false,
  },
  heroSub: {
    fontSize: FontSize.sm,
    color: Colors.textSecondary,
    includeFontPadding: false,
  },
  card: {
    margin: Spacing.md,
    backgroundColor: Colors.surfaceElevated,
    borderRadius: Radius.xl,
    padding: Spacing.lg,
    borderWidth: 1,
    borderColor: Colors.surfaceBorder,
    gap: Spacing.md,
  },
  cardTitle: {
    fontSize: FontSize.xxl,
    fontWeight: FontWeight.bold,
    color: Colors.textPrimary,
    includeFontPadding: false,
  },
  cardSub: {
    fontSize: FontSize.sm,
    color: Colors.textSecondary,
    lineHeight: 20,
    includeFontPadding: false,
    marginTop: -Spacing.sm,
  },
  appleBtn: {
    width: '100%',
    height: 50,
    borderRadius: 50,
  },
  appleFallbackBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    backgroundColor: '#ffffff',
    borderRadius: 50,
    height: 50,
    width: '100%',
  },
  appleFallbackText: {
    fontSize: FontSize.md,
    fontWeight: FontWeight.semibold,
    color: '#000000',
    includeFontPadding: false,
  },
  socialBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 10,
    backgroundColor: Colors.surface,
    borderRadius: Radius.full,
    paddingVertical: 14,
    borderWidth: 1.5,
    borderColor: Colors.surfaceBorder,
    minHeight: 50,
  },
  socialBtnText: {
    fontSize: FontSize.md,
    fontWeight: FontWeight.semibold,
    color: Colors.textPrimary,
    includeFontPadding: false,
  },
  divider: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.sm,
  },
  dividerLine: {
    flex: 1,
    height: 1,
    backgroundColor: Colors.surfaceBorder,
  },
  dividerText: {
    fontSize: FontSize.sm,
    color: Colors.textMuted,
    includeFontPadding: false,
  },
  emailBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    backgroundColor: 'transparent',
    borderRadius: Radius.full,
    paddingVertical: 14,
    borderWidth: 1,
    borderColor: Colors.surfaceBorder,
    minHeight: 50,
  },
  emailBtnText: {
    fontSize: FontSize.md,
    fontWeight: FontWeight.semibold,
    color: Colors.textSecondary,
    includeFontPadding: false,
  },
  backRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    marginBottom: -4,
  },
  backText: {
    fontSize: FontSize.sm,
    color: Colors.textSecondary,
    includeFontPadding: false,
  },
  inputGroup: {
    gap: 6,
  },
  inputLabel: {
    fontSize: FontSize.sm,
    fontWeight: FontWeight.semibold,
    color: Colors.textSecondary,
    includeFontPadding: false,
  },
  input: {
    backgroundColor: Colors.surface,
    borderRadius: Radius.md,
    borderWidth: 1,
    borderColor: Colors.surfaceBorder,
    padding: Spacing.sm + 4,
    fontSize: FontSize.md,
    color: Colors.textPrimary,
    minHeight: 48,
    includeFontPadding: false,
  },
  primaryBtn: {
    backgroundColor: Colors.primary,
    borderRadius: Radius.full,
    paddingVertical: 15,
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 50,
  },
  primaryBtnText: {
    fontSize: FontSize.md,
    fontWeight: FontWeight.bold,
    color: '#fff',
    includeFontPadding: false,
  },
  otpIcon: {
    alignSelf: 'center',
    width: 64,
    height: 64,
    borderRadius: 32,
    backgroundColor: Colors.primaryGlow,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: Colors.primary + '44',
  },
  otpInput: {
    textAlign: 'center',
    fontSize: FontSize.xxl,
    fontWeight: FontWeight.bold,
    letterSpacing: 8,
  },
  switchText: {
    textAlign: 'center',
    fontSize: FontSize.sm,
    color: Colors.textSecondary,
    includeFontPadding: false,
  },
  switchLink: {
    color: Colors.primaryLight,
    fontWeight: FontWeight.semibold,
  },
  footer: {
    textAlign: 'center',
    fontSize: FontSize.xs,
    color: Colors.textMuted,
    paddingHorizontal: Spacing.xl,
    marginTop: Spacing.sm,
    includeFontPadding: false,
  },
});
