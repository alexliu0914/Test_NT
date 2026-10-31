'use client';
// 登入：帳號密碼 → 兩步驟驗證碼（或備援碼）
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Alert, Anchor, Button, Center, Paper, PasswordInput, PinInput, Stack, Text, TextInput, Title } from '@mantine/core';
import { authClient } from '@/lib/auth-client';

type Step = 'password' | 'totp' | 'backup';

export default function LoginPage() {
  const router = useRouter();
  const [step, setStep] = useState<Step>('password');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submitPassword(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setError(null);
    const r = await authClient.signIn.email({ email, password });
    setBusy(false);
    if (r.error) { setError(r.error.status === 429 ? r.error.message || '登入嘗試次數過多，請 15 分鐘後再試' : 'Email 或密碼不正確'); return; }
    if ((r.data as { twoFactorRedirect?: boolean } | null)?.twoFactorRedirect) { setStep('totp'); return; }
    router.replace('/');   // 尚未設定兩步驟驗證：首頁會導向設定頁
    router.refresh();
  }

  async function submitCode(e?: React.FormEvent) {
    e?.preventDefault();
    setBusy(true); setError(null);
    const r = step === 'totp'
      ? await authClient.twoFactor.verifyTotp({ code })
      : await authClient.twoFactor.verifyBackupCode({ code });
    setBusy(false);
    if (r.error) { setError(r.error.status === 429 || /lock/i.test(r.error.message || '') ? '驗證失敗次數過多，請稍後再試' : '驗證碼不正確'); return; }
    router.replace('/');
    router.refresh();
  }

  return (
    <Center mih="100dvh" p="md">
      <Paper withBorder p="xl" w={380} maw="100%">
        {step === 'password' ? (
          <form onSubmit={submitPassword}>
            <Stack>
              <Title order={2}>登入</Title>
              <TextInput id="email" label="Email" type="email" autoComplete="username" required value={email} onChange={e => setEmail(e.currentTarget.value)} />
              <PasswordInput id="password" label="密碼" autoComplete="current-password" required value={password} onChange={e => setPassword(e.currentTarget.value)} />
              {error && <Alert color="red" data-testid="login-error">{error}</Alert>}
              <Button type="submit" loading={busy}>登入</Button>
            </Stack>
          </form>
        ) : (
          <form onSubmit={submitCode}>
            <Stack>
              <Title order={2}>兩步驟驗證</Title>
              {step === 'totp' ? (
                <>
                  <Text size="sm">輸入驗證器 App 顯示的 6 位數驗證碼。</Text>
                  <PinInput id="totp" length={6} type="number" oneTimeCode autoFocus value={code} onChange={setCode} onComplete={() => {}} />
                </>
              ) : (
                <>
                  <Text size="sm">輸入一組備援碼。每組只能使用一次。</Text>
                  <TextInput id="backup" label="備援碼" autoComplete="one-time-code" value={code} onChange={e => setCode(e.currentTarget.value.trim())} />
                </>
              )}
              {error && <Alert color="red" data-testid="login-error">{error}</Alert>}
              <Button type="submit" loading={busy} disabled={code.length < 6}>驗證</Button>
              <Anchor component="button" type="button" size="sm" onClick={() => { setStep(step === 'totp' ? 'backup' : 'totp'); setCode(''); setError(null); }}>
                {step === 'totp' ? '改用備援碼' : '改用驗證器 App'}
              </Anchor>
            </Stack>
          </form>
        )}
      </Paper>
    </Center>
  );
}
