'use client';
// 強制設定兩步驟驗證（FR-02）：輸入密碼 → 掃描 QR Code、保存 10 組備援碼 → 輸入驗證碼確認
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import QRCode from 'qrcode';
import { Alert, Button, Center, Checkbox, Code, Group, Image, Paper, PasswordInput, PinInput, SimpleGrid, Stack, Text, Title } from '@mantine/core';
import { authClient } from '@/lib/auth-client';

export default function SetupTwoFactor({ email }: { email: string }) {
  const router = useRouter();
  const [password, setPassword] = useState('');
  const [qr, setQr] = useState<string | null>(null);
  const [secret, setSecret] = useState('');
  const [codes, setCodes] = useState<string[]>([]);
  const [saved, setSaved] = useState(false);
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function start(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setError(null);
    const r = await authClient.twoFactor.enable({ password });
    setBusy(false);
    if (r.error || !r.data || !('totpURI' in r.data)) { setError('密碼不正確'); return; }
    const uri = r.data.totpURI;
    setSecret(new URL(uri).searchParams.get('secret') || '');
    setQr(await QRCode.toDataURL(uri, { margin: 1, width: 220 }));
    setCodes(r.data.backupCodes);
  }

  async function verify(e?: React.FormEvent) {
    e?.preventDefault();
    setBusy(true); setError(null);
    const r = await authClient.twoFactor.verifyTotp({ code });
    setBusy(false);
    if (r.error) { setError('驗證碼不正確，請確認手機時間正確後再試'); return; }
    router.replace('/');
    router.refresh();
  }

  return (
    <Center mih="100dvh" p="md">
      <Paper withBorder p="xl" w={460} maw="100%">
        <Stack>
          <Title order={2}>設定兩步驟驗證</Title>
          <Text size="sm">{email} 必須先完成兩步驟驗證才能使用工作區。</Text>
          {!qr ? (
            <form onSubmit={start}>
              <Stack>
                <PasswordInput id="password" label="再次輸入密碼" autoComplete="current-password" required value={password} onChange={e => setPassword(e.currentTarget.value)} />
                {error && <Alert color="red">{error}</Alert>}
                <Button type="submit" loading={busy}>開始設定</Button>
              </Stack>
            </form>
          ) : (
            <form onSubmit={verify}>
              <Stack>
                <Text size="sm" fw={600}>1. 用驗證器 App（例如 Google Authenticator、1Password）掃描</Text>
                <Group align="flex-start">
                  <Image src={qr} alt="兩步驟驗證 QR Code" w={180} h={180} />
                  <Stack gap={4} style={{ minWidth: 0 }}>
                    <Text size="xs" c="dimmed">無法掃描時手動輸入：</Text>
                    <Code data-testid="totp-secret" style={{ wordBreak: 'break-all' }}>{secret}</Code>
                  </Stack>
                </Group>
                <Text size="sm" fw={600}>2. 保存這 10 組備援碼（手機遺失時用來登入，每組只能用一次）</Text>
                <SimpleGrid cols={2} spacing={4} data-testid="backup-codes">
                  {codes.map(c => <Code key={c}>{c}</Code>)}
                </SimpleGrid>
                <Checkbox id="saved" label="我已經把備援碼存在安全的地方" checked={saved} onChange={e => setSaved(e.currentTarget.checked)} />
                <Text size="sm" fw={600}>3. 輸入 App 顯示的 6 位數驗證碼</Text>
                <PinInput id="totp" length={6} type="number" oneTimeCode value={code} onChange={setCode} />
                {error && <Alert color="red">{error}</Alert>}
                <Button type="submit" loading={busy} disabled={!saved || code.length !== 6}>完成設定</Button>
              </Stack>
            </form>
          )}
        </Stack>
      </Paper>
    </Center>
  );
}
