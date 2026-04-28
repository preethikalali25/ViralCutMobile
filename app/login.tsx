import React, { useState } from 'react';
import {
  View, Text, StyleSheet, Pressable, TextInput,
  KeyboardAvoidingView, Platform, ScrollView, ActivityIndicator,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Image } from 'expo-image';
import { MaterialIcons, MaterialCommunityIcons } from '@expo/vector-icons';
import { useAuth, useAlert } from '@/template';
import { Colors, Spacing, Radius, FontSize, FontWeight } from '@/constants/theme';

type Mode = 'landing' | 'email-login' | 'email-signup' | 'otp';

export default function LoginScreen() {
  const { signInWithGoogle, signInWithPassword, sendOTP, verifyOTPAndLogin, operationLoading } = useAuth();
  const { showAlert } = useAlert();

  const [mode, setMode] = useState<Mode>('landing');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [otp, setOtp] = useState('');
  const [pendingEmail, setPendingEmail] = useState('');
  const [pendingPassword, setPendingPassword] = useState('');
  const [showPass, setShowPass] = useState(false);

  const handleGoogle = async () => {
    const { error } = await signInWithGoogle();
    if (error) showAlert('Google Sign-In Failed', error);
  };

  const handleEmailLogin = async () => {
    if (!email.trim() || !password) {
      showAlert('Missing Fields', 'Please enter your email and password.');
      return;
    }
    const { error } = await signInWithPassword(email.trim(), password);
    if (error) showAlert('Login Failed', error);
  };

  const handleSendOTP = async () => {
    if (!email.trim()) {
      showAlert('Missing Email', 'Please enter your email address.');
      return;
    }
    if (!password || password.length < 6) {
      showAlert('Weak Password', 'Password must be at least 6 characters.');
      return;
    }
    if (password !== confirmPassword) {
      showAlert('Password Mismatch', 'Passwords do not match.');
      return;
    }
    const { error } = await sendOTP(email.trim());
    if (error) {
      showAlert('Failed to Send OTP', error);
      return;
    }
    setPendingEmail(email.trim());
    setPendingPassword(password);
    setMode('otp');
    showAlert('Check Your Email', 'A verification code has been sent to your email.');
  };

  const handleVerifyOTP = async () => {
    if (!otp.trim()) {
      showAlert('Enter Code', 'Please enter the verification code.');
      return;
    }
    const { error } = await verifyOTPAndLogin(pendingEmail, otp.trim(), { password: pendingPassword });
    if (error) showAlert('Verification Failed', error);
  };

  return (
    <SafeAreaView style={styles.safe}>
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : 'height'}>
        <ScrollView contentContainerStyle={styles.scrollContent} showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled">

          {/* Hero Image */}
          <View style={styles.heroWrapper}>
            <Image
              source={require('@/assets/images/login-bg.png')}
              style={styles.heroImage}
              contentFit="cover"
              transition={300}
            />
            <View style={styles.heroOverlay}>
              <MaterialCommunityIcons name="scissors-cutting" size={32} color={Colors.primaryLight} />
              <Text style={styles.heroTitle}>ViralCut</Text>
              <Text style={styles.heroSub}>Your short-form video studio</Text>
            </View>
          </View>

          {/* Card */}
          <View style={styles.card}>

            {/* Landing */}
            {mode === 'landing' ? (
              <>
                <Text style={styles.cardTitle}>Get Started</Text>
                <Text style={styles.cardSub}>Sign in to manage your videos</Text>

                {/* Google */}
                <Pressable
                  style={({ pressed }) => [styles.googleBtn, pressed && { opacity: 0.85 }]}
                  onPress={handleGoogle}
                  disabled={operationLoading}
                >
                  {operationLoading ? (
                    <ActivityIndicator color={Colors.textPrimary} size="small" />
                  ) : (
                    <>
                      <MaterialCommunityIcons name="google" size={20} color="#EA4335" />
                      <Text style={styles.googleBtnText}>Continue with Google</Text>
                    </>
                  )}
                </Pressable>

                {/* Divider */}
                <View style={styles.divider}>
                  <View style={styles.dividerLine} />
                  <Text style={styles.dividerText}>or</Text>
                  <View style={styles.dividerLine} />
                </View>

                {/* Email options */}
                <Pressable
                  style={({ pressed }) => [styles.emailBtn, pressed && { opacity: 0.85 }]}
                  onPress={() => setMode('email-login')}
                >
                  <MaterialIcons name="email" size={18} color={Colors.textSecondary} />
                  <Text style={styles.emailBtnText}>Continue with Email</Text>
                </Pressable>

                <Pressable onPress={() => setMode('email-signup')}>
                  <Text style={styles.switchText}>
                    New here? <Text style={styles.switchLink}>Create an account</Text>
                  </Text>
                </Pressable>
              </>
            ) : null}

            {/* Email Login */}
            {mode === 'email-login' ? (
              <>
                <Pressable style={styles.backRow} onPress={() => setMode('landing')}>
                  <MaterialIcons name="arrow-back" size={16} color={Colors.textSecondary} />
                  <Text style={styles.backText}>Back</Text>
                </Pressable>
                <Text style={styles.cardTitle}>Welcome Back</Text>
                <Text style={styles.cardSub}>Sign in with your email</Text>

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
                  />
                </View>

                <View style={styles.inputGroup}>
                  <Text style={styles.inputLabel}>Password</Text>
                  <View style={styles.inputRow}>
                    <TextInput
                      style={[styles.input, { flex: 1, borderWidth: 0, padding: 0 }]}
                      value={password}
                      onChangeText={setPassword}
                      placeholder="••••••••"
                      placeholderTextColor={Colors.textMuted}
                      secureTextEntry={!showPass}
                      autoComplete="password"
                    />
                    <Pressable onPress={() => setShowPass(p => !p)} hitSlop={8}>
                      <MaterialIcons name={showPass ? 'visibility-off' : 'visibility'} size={18} color={Colors.textMuted} />
                    </Pressable>
                  </View>
                </View>

                <Pressable
                  style={({ pressed }) => [styles.primaryBtn, pressed && { opacity: 0.85 }]}
                  onPress={handleEmailLogin}
                  disabled={operationLoading}
                >
                  {operationLoading ? (
                    <ActivityIndicator color="#fff" size="small" />
                  ) : (
                    <Text style={styles.primaryBtnText}>Sign In</Text>
                  )}
                </Pressable>

                <Pressable onPress={() => setMode('email-signup')}>
                  <Text style={styles.switchText}>
                    No account? <Text style={styles.switchLink}>Sign up</Text>
                  </Text>
                </Pressable>
              </>
            ) : null}

            {/* Email Sign Up */}
            {mode === 'email-signup' ? (
              <>
                <Pressable style={styles.backRow} onPress={() => setMode('landing')}>
                  <MaterialIcons name="arrow-back" size={16} color={Colors.textSecondary} />
                  <Text style={styles.backText}>Back</Text>
                </Pressable>
                <Text style={styles.cardTitle}>Create Account</Text>
                <Text style={styles.cardSub}>Join thousands of creators</Text>

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
                  />
                </View>

                <View style={styles.inputGroup}>
                  <Text style={styles.inputLabel}>Password</Text>
                  <View style={styles.inputRow}>
                    <TextInput
                      style={[styles.input, { flex: 1, borderWidth: 0, padding: 0 }]}
                      value={password}
                      onChangeText={setPassword}
                      placeholder="Min 6 characters"
                      placeholderTextColor={Colors.textMuted}
                      secureTextEntry={!showPass}
                    />
                    <Pressable onPress={() => setShowPass(p => !p)} hitSlop={8}>
                      <MaterialIcons name={showPass ? 'visibility-off' : 'visibility'} size={18} color={Colors.textMuted} />
                    </Pressable>
                  </View>
                </View>

                <View style={styles.inputGroup}>
                  <Text style={styles.inputLabel}>Confirm Password</Text>
                  <TextInput
                    style={styles.input}
                    value={confirmPassword}
                    onChangeText={setConfirmPassword}
                    placeholder="Re-enter password"
                    placeholderTextColor={Colors.textMuted}
                    secureTextEntry
                  />
                </View>

                <Pressable
                  style={({ pressed }) => [styles.primaryBtn, pressed && { opacity: 0.85 }]}
                  onPress={handleSendOTP}
                  disabled={operationLoading}
                >
                  {operationLoading ? (
                    <ActivityIndicator color="#fff" size="small" />
                  ) : (
                    <Text style={styles.primaryBtnText}>Send Verification Code</Text>
                  )}
                </Pressable>

                <Pressable onPress={() => setMode('email-login')}>
                  <Text style={styles.switchText}>
                    Have an account? <Text style={styles.switchLink}>Sign in</Text>
                  </Text>
                </Pressable>
              </>
            ) : null}

            {/* OTP Verification */}
            {mode === 'otp' ? (
              <>
                <View style={styles.otpIcon}>
                  <MaterialIcons name="mark-email-read" size={32} color={Colors.primaryLight} />
                </View>
                <Text style={styles.cardTitle}>Check Your Email</Text>
                <Text style={styles.cardSub}>
                  We sent a code to{'\n'}
                  <Text style={{ color: Colors.primaryLight }}>{pendingEmail}</Text>
                </Text>

                <View style={styles.inputGroup}>
                  <Text style={styles.inputLabel}>Verification Code</Text>
                  <TextInput
                    style={[styles.input, styles.otpInput]}
                    value={otp}
                    onChangeText={setOtp}
                    placeholder="Enter 4-digit code"
                    placeholderTextColor={Colors.textMuted}
                    keyboardType="number-pad"
                    maxLength={4}
                  />
                </View>

                <Pressable
                  style={({ pressed }) => [styles.primaryBtn, pressed && { opacity: 0.85 }]}
                  onPress={handleVerifyOTP}
                  disabled={operationLoading}
                >
                  {operationLoading ? (
                    <ActivityIndicator color="#fff" size="small" />
                  ) : (
                    <Text style={styles.primaryBtnText}>Verify & Create Account</Text>
                  )}
                </Pressable>

                <Pressable
                  onPress={async () => {
                    const { error } = await sendOTP(pendingEmail);
                    if (!error) showAlert('Code Resent', 'A new verification code has been sent.');
                    else showAlert('Failed', error);
                  }}
                  disabled={operationLoading}
                >
                  <Text style={styles.switchText}>
                    Didn't get it? <Text style={styles.switchLink}>Resend code</Text>
                  </Text>
                </Pressable>

                <Pressable style={{ marginTop: 4 }} onPress={() => setMode('email-signup')}>
                  <Text style={styles.switchText}>
                    <Text style={styles.switchLink}>← Change email</Text>
                  </Text>
                </Pressable>
              </>
            ) : null}

          </View>

          {/* Footer */}
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
    inset: 0,
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
  googleBtn: {
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
  googleBtnText: {
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
  inputRow: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: Colors.surface,
    borderRadius: Radius.md,
    borderWidth: 1,
    borderColor: Colors.surfaceBorder,
    paddingHorizontal: Spacing.sm + 4,
    minHeight: 48,
    gap: 8,
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
  footer: {
    textAlign: 'center',
    fontSize: FontSize.xs,
    color: Colors.textMuted,
    paddingHorizontal: Spacing.xl,
    marginTop: Spacing.sm,
    includeFontPadding: false,
  },
});
