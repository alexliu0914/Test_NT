'use client';
// 設定：登入裝置（撤銷、登出其他裝置）、邀請（管理者）、登出（先處理尚未同步的草稿）
import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Alert, Anchor, Badge, Button, Code, Container, CopyButton, Group, Modal, Paper, Stack, Table, Text, TextInput, Title } from '@mantine/core';
import { authClient } from '@/lib/auth-client';
import type { AuthedUser } from '@/lib/guard';
import { IdbStore } from '@shared/idb-store.js';

type Sess = { id: string; createdAt: string; lastActiveAt: string; ip: string | null; userAgent: string | null; current: boolean };

function device(ua: string | null) {
  if (!ua) return '未知裝置';
  const os = /iPhone|iPad/.test(ua) ? 'iOS' : /Android/.test(ua) ? 'Android' : /Mac OS X/.test(ua) ? 'macOS' : /Windows/.test(ua) ? 'Windows' : /Linux/.test(ua) ? 'Linux' : '';
  const br = /Edg\//.test(ua) ? 'Edge' : /Chrome\//.test(ua) ? 'Chrome' : /Firefox\//.test(ua) ? 'Firefox' : /Safari\//.test(ua) ? 'Safari' : '';
  return [br, os].filter(Boolean).join(' · ') || '瀏覽器';
}

export default function Settings({ user }: { user: AuthedUser }) {
  const router = useRouter();
  const [sessions, setSessions] = useState<Sess[]>([]);
  const [msg, setMsg] = useState<string | null>(null);
  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteUrl, setInviteUrl] = useState<string | null>(null);
  const [unsynced, setUnsynced] = useState<{ key: string }[] | null>(null);

  const load = useCallback(async () => {
    const r = await fetch('/api/sessions', { cache: 'no-store' });
    if (r.status === 401) { router.replace('/login'); return; }
    if (r.ok) setSessions((await r.json()).sessions);
  }, [router]);
  useEffect(() => { load(); }, [load]);

  async function revoke(id: string) {
    const r = await fetch(`/api/sessions/${encodeURIComponent(id)}`, { method: 'DELETE' });
    if (r.ok) { const j = await r.json(); if (j.current) { router.replace('/login'); return; } setMsg('已登出該裝置'); load(); }
  }
  async function revokeOthers() {
    const r = await fetch('/api/sessions/revoke-others', { method: 'POST' });
    if (r.ok) { setMsg(`已登出其他 ${(await r.json()).revoked} 個裝置`); load(); }
  }
  async function invite(e: React.FormEvent) {
    e.preventDefault();
    setInviteUrl(null);
    const r = await fetch('/api/invites', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: inviteEmail }) });
    const j = await r.json();
    if (!r.ok) { setMsg(j.error?.message || '建立邀請失敗'); return; }
    setInviteUrl(j.url);
  }

  // 登出前檢查這個帳號在此裝置上是否有尚未同步的修改
  async function startLogout() {
    let list: { key: string }[] = [];
    try { list = await IdbStore.unsyncedFor(user.id); } catch { /* IndexedDB 無法使用 */ }
    if (list.length) { setUnsynced(list); return; }
    await finishLogout(true);
  }
  async function finishLogout(clearDrafts: boolean, discard = false) {
    try {
      if (discard && unsynced) await IdbStore.deleteKeys(unsynced.map(u => u.key));
      if (clearDrafts) { const mine = await IdbStore.unsyncedFor(user.id); if (!mine.length) await IdbStore.clearUser(user.id); }
    } catch { /* 略過 */ }
    await authClient.signOut();
    router.replace('/login');
    router.refresh();
  }

  return (
    <Container size="sm" py="xl">
      <Stack gap="xl">
        <Group justify="space-between">
          <Title order={2}>設定</Title>
          <Anchor href="/">回到工作區</Anchor>
        </Group>
        {msg && <Alert onClose={() => setMsg(null)} withCloseButton>{msg}</Alert>}

        <Paper withBorder p="lg">
          <Stack>
            <Group justify="space-between"><Title order={4}>登入的裝置</Title>
              <Button variant="light" size="xs" onClick={revokeOthers} disabled={sessions.length < 2}>登出其他所有裝置</Button></Group>
            <Table.ScrollContainer minWidth={420}>
              <Table data-testid="sessions">
                <Table.Thead><Table.Tr><Table.Th>裝置</Table.Th><Table.Th>最後使用</Table.Th><Table.Th /></Table.Tr></Table.Thead>
                <Table.Tbody>
                  {sessions.map(s => (
                    <Table.Tr key={s.id}>
                      <Table.Td>{device(s.userAgent)} {s.current && <Badge size="xs" ml={4}>這台</Badge>}<Text size="xs" c="dimmed">{s.ip || ''}</Text></Table.Td>
                      <Table.Td><Text size="sm">{new Date(s.lastActiveAt).toLocaleString('zh-TW')}</Text></Table.Td>
                      <Table.Td>{!s.current && <Button size="xs" variant="subtle" color="red" onClick={() => revoke(s.id)}>登出</Button>}</Table.Td>
                    </Table.Tr>
                  ))}
                </Table.Tbody>
              </Table>
            </Table.ScrollContainer>
          </Stack>
        </Paper>

        {user.role === 'admin' && (
          <Paper withBorder p="lg">
            <form onSubmit={invite}>
              <Stack>
                <Title order={4}>邀請成員</Title>
                <Text size="sm" c="dimmed">連結 72 小時內有效，只能使用一次。</Text>
                <Group align="flex-end"><TextInput id="invite-email" label="Email" type="email" required style={{ flex: 1 }} value={inviteEmail} onChange={e => setInviteEmail(e.currentTarget.value)} />
                  <Button type="submit">建立邀請連結</Button></Group>
                {inviteUrl && (
                  <Group wrap="nowrap" gap="xs"><Code data-testid="invite-url" style={{ wordBreak: 'break-all', flex: 1 }}>{inviteUrl}</Code>
                    <CopyButton value={inviteUrl}>{({ copied, copy }) => <Button size="xs" variant="light" onClick={copy}>{copied ? '已複製' : '複製'}</Button>}</CopyButton></Group>
                )}
              </Stack>
            </form>
          </Paper>
        )}

        <Paper withBorder p="lg">
          <Group justify="space-between"><Stack gap={0}><Text fw={600}>{user.name}</Text><Text size="sm" c="dimmed">{user.email}</Text></Stack>
            <Button color="red" variant="light" onClick={startLogout}>登出</Button></Group>
        </Paper>
      </Stack>

      <Modal opened={!!unsynced} onClose={() => setUnsynced(null)} title="還有尚未同步的修改">
        <Stack>
          <Text size="sm">這台裝置上有 {unsynced?.length} 份文件的修改還沒存到伺服器。</Text>
          <Text size="sm">保留草稿登出：下次用同一個帳號登入時會自動補送；其他帳號在這台裝置登入前必須先處理這些草稿。</Text>
          <Button onClick={() => finishLogout(false)}>保留草稿並登出</Button>
          <Button variant="light" color="red" onClick={() => finishLogout(false, true)}>捨棄這些修改並登出</Button>
          <Button variant="subtle" onClick={() => setUnsynced(null)}>取消，先回去同步</Button>
        </Stack>
      </Modal>
    </Container>
  );
}
