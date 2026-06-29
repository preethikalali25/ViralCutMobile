import { useEffect, useState } from 'react';
import { AuthRouter } from '@/template';
import { Redirect } from 'expo-router';
import { hasCompletedOnboarding } from './onboarding';

function AuthenticatedRoot() {
  const [checked, setChecked] = useState(false);
  const [needsOnboarding, setNeedsOnboarding] = useState(false);

  useEffect(() => {
    hasCompletedOnboarding().then(done => {
      setNeedsOnboarding(!done);
      setChecked(true);
    });
  }, []);

  if (!checked) return null;
  if (needsOnboarding) return <Redirect href="/onboarding" />;
  return <Redirect href="/(tabs)" />;
}

export default function RootScreen() {
  return (
    <AuthRouter loginRoute="/login">
      <AuthenticatedRoot />
    </AuthRouter>
  );
}
