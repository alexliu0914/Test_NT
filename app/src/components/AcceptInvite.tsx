'use client';
// 以邀請連結建立帳號（72 小時有效、只能用一次）
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Alert, Button, Center, Paper, PasswordInput, Stack, Text, TextInput, Title } from '@mantine/core';

export default function AcceptInvite({ token, email }: { token: string; email: string | null }) {
  const router = useRouter();
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (!email) {
    return (
      <Center mih="100dvh" p="md"><Paper withBorder p="xl" w={380} maw="100%">
        <Stack><Title order={2}>邀請連結無效</Title><Text size="sm">這個連結已經用過或已過期。請向管理者索取新的邀請連結。</Text></Stack>
      </Paper></Center>
    );
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (password !== confirm) { setError('兩次輸入的密碼不一樣'); return; }
    setBusy(true); setError(null);
    const r = await fetch(`/api/invites/${encodeURIComponent(token)}/accept`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name, password }),
    });
    setBusy(false);
    if (!r.ok) { const j = await r.json().catch(() => null); setError(j?.error?.message || '建立帳號失敗'); return; }
    router.replace('/login');
  }

  return (
    <Center mih="100dvh" p="md">
      <Paper withBorder p="xl" w={380} maw="100%">
        <form onSubmit={submit}>
          <Stack>
            <Title order={2}>建立帳號</Title>
            <Text size="sm">{email}</Text>
            <TextInput id="name" label="名字" required value={name} onChange={e => setName(e.currentTarget.value)} />
            <PasswordInput id="new-password" label="密碼（至少 12 個字元）" autoComplete="new-password" required minLength={12} value={password} onChange={e => setPassword(e.currentTarget.value)} />
            <PasswordInput id="confirm-password" label="再輸入一次" autoComplete="new-password" required value={confirm} onChange={e => setConfirm(e.currentTarget.value)} />
            {error && <Alert color="red">{error}</Alert>}
            <Button type="submit" loading={busy}>建立帳號</Button>
          </Stack>
        </form>
      </Paper>
    </Center>
  );
}
