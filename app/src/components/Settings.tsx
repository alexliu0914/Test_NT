'use client';
// 設定：登入裝置（撤銷、登出其他裝置）、邀請（管理者）、此裝置上的草稿、登出（先處理尚未同步的草稿）
// M2-c W5（SEC-12）：登出時最多同步 10 秒；仍未同步時可繼續等待、下載 JSON、保留草稿並登出、捨棄並登出、取消。
// 只處理目前帳號自己的草稿；其他帳號的草稿看不到、不能下載或刪除，也不顯示數量。
import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Alert, Anchor, Badge, Button, Code, Container, CopyButton, Group, Modal, Paper, Stack, Table, Text, TextInput, Title } from '@mantine/core';
import { authClient } from '@/lib/auth-client';
import type { AuthedUser } from '@/lib/guard';
import { IdbStore } from '@shared/idb-store.js';
import { syncDrafts, describeDrafts } from '@/lib/draft-sync';

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
  const [step, setStep] = useState<null | 'syncing' | 'options' | 'keep' | 'discard'>(null);
  const [left, setLeft] = useState(10);
  const [mine, setMine] = useState<{ total: number; unsynced: number } | null>(null);
  const [orphans, setOrphans] = useState(0);
  const [confirmDelete, setConfirmDelete] = useState<null | 'mine' | 'orphans'>(null);
  const loadDrafts = useCallback(async () => {
    try {
      const all = await IdbStore.draftsFor(user.id);
      const un = await IdbStore.unsyncedFor(user.id);
      setMine({ total: all.length, unsynced: un.length });
      setOrphans(await IdbStore.orphanCount());
    } catch { setMine(null); }
  }, [user.id]);
  useEffect(() => { loadDrafts(); }, [loadDrafts]);

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

  // 登出：檢查這個帳號在此裝置上所有尚未同步的草稿；有就先嘗試同步最多 10 秒
  async function startLogout() {
    let list: { key: string }[] = [];
    try { list = await IdbStore.unsyncedFor(user.id); } catch { /* IndexedDB 無法使用 */ }
    if (!list.length) { await finishLogout('clear'); return; }
    await trySync();
  }
  async function trySync() {
    setStep('syncing'); setLeft(10);
    let rest: { key: string }[] = [];
    try { rest = await syncDrafts(user.id, 10000, setLeft); } catch { rest = await IdbStore.unsyncedFor(user.id).catch(() => []); }
    if (!rest.length) { await finishLogout('clear'); return; }
    setUnsynced(rest); setStep('options');
  }
  async function download() {
    const data = await describeDrafts(user.id);
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([JSON.stringify(data, null, 1)], { type: 'application/json' }));
    a.download = 'unsynced-drafts.json';
    a.click();
  }
  // clear：沒有未同步內容，清除這個帳號在此裝置的草稿；keep：保留草稿（不清除）；discard：二次確認後捨棄這個帳號未同步的草稿
  async function finishLogout(mode: 'clear' | 'keep' | 'discard') {
    try {
      if (mode === 'discard' && unsynced) await IdbStore.deleteOwn(user.id, unsynced.map(u => u.key));
      if (mode === 'clear') { const left2 = await IdbStore.unsyncedFor(user.id); if (!left2.length) await IdbStore.clearUser(user.id); }
    } catch { /* 略過 */ }
    await authClient.signOut();
    router.replace('/login');
    router.refresh();
  }
  async function deleteDrafts() {
    if (confirmDelete === 'mine') await IdbStore.clearUser(user.id);
    if (confirmDelete === 'orphans') await IdbStore.clearOrphans();
    setConfirmDelete(null);
    loadDrafts();
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

        <Paper withBorder p="lg" data-testid="drafts-section">
          <Stack gap="xs">
            <Title order={4}>此裝置上的草稿</Title>
            <Text size="sm" data-testid="drafts-count" data-total={mine?.total ?? 0} data-unsynced={mine?.unsynced ?? 0}>
              你在這台裝置上有 {mine?.total ?? 0} 份草稿{mine && mine.unsynced ? `，其中 ${mine.unsynced} 份尚未同步` : ''}。
            </Text>
            <Group gap="xs">
              <Button size="xs" variant="default" disabled={!mine?.unsynced} onClick={download} data-testid="drafts-download">下載尚未同步的內容</Button>
              <Button size="xs" variant="light" color="red" disabled={!mine?.total} onClick={() => setConfirmDelete('mine')} data-testid="drafts-delete">刪除我在這台裝置的草稿</Button>
            </Group>
            {orphans > 0 && (
              <Group gap="xs" data-testid="orphans">
                <Text size="sm" data-testid="orphans-count" data-n={orphans}>此裝置有 {orphans} 份無法辨識帳號的舊草稿（不會載入或送出）。</Text>
                <Button size="xs" variant="subtle" color="red" onClick={() => setConfirmDelete('orphans')} data-testid="orphans-clear">清除</Button>
              </Group>
            )}
          </Stack>
        </Paper>

        <Paper withBorder p="lg">
          <Group justify="space-between"><Stack gap={0}><Text fw={600}>{user.name}</Text><Text size="sm" c="dimmed">{user.email}</Text></Stack>
            <Button color="red" variant="light" onClick={startLogout} data-testid="logout-button">登出</Button></Group>
        </Paper>
      </Stack>

      <Modal opened={step === 'syncing'} onClose={() => {}} withCloseButton={false} title="正在同步" data-testid="logout-syncing">
        <Text size="sm">正在把尚未同步的修改送到伺服器（最多 10 秒，剩 {left} 秒）…</Text>
      </Modal>
      <Modal opened={step === 'options'} onClose={() => setStep(null)} title="還有尚未同步的修改" data-testid="logout-options">
        <Stack>
          <Text size="sm">這台裝置上有 {unsynced?.length} 份文件的修改還沒存到伺服器。</Text>
          <Button onClick={trySync} data-testid="logout-wait">繼續等待（再試 10 秒）</Button>
          <Button variant="default" onClick={download} data-testid="logout-download">下載未同步內容（JSON）</Button>
          <Button variant="light" onClick={() => setStep('keep')} data-testid="logout-keep">保留草稿並登出</Button>
          <Button variant="light" color="red" onClick={() => setStep('discard')} data-testid="logout-discard">捨棄修改並登出</Button>
          <Button variant="subtle" onClick={() => setStep(null)} data-testid="logout-cancel">取消</Button>
        </Stack>
      </Modal>
      <Modal opened={step === 'keep'} onClose={() => setStep('options')} title="保留草稿並登出" data-testid="logout-keep-dialog">
        <Stack>
          <Text size="sm" data-testid="shared-device-warning">資料仍留在此瀏覽器裝置，其他能存取此裝置或瀏覽器設定的人可能取得本機資料。</Text>
          <Text size="sm">下次用同一個帳號登入並開啟這些頁面時會補送；其他帳號在這台裝置上看不到、也不會送出這些草稿。之後可以在「設定 → 此裝置上的草稿」刪除。</Text>
          <Group justify="flex-end"><Button variant="default" onClick={() => setStep('options')}>返回</Button>
            <Button onClick={() => finishLogout('keep')} data-testid="logout-keep-confirm">保留並登出</Button></Group>
        </Stack>
      </Modal>
      <Modal opened={step === 'discard'} onClose={() => setStep('options')} title="捨棄修改並登出" data-testid="logout-discard-dialog">
        <Stack>
          <Text size="sm">確定捨棄？這台裝置上尚未同步的修改會永久消失，無法復原。</Text>
          <Group justify="flex-end"><Button variant="default" onClick={() => setStep('options')}>返回</Button>
            <Button color="red" onClick={() => finishLogout('discard')} data-testid="logout-discard-confirm">確定捨棄並登出</Button></Group>
        </Stack>
      </Modal>
      <Modal opened={!!confirmDelete} onClose={() => setConfirmDelete(null)} title={confirmDelete === 'orphans' ? '清除無法辨識帳號的舊草稿' : '刪除我在這台裝置的草稿'}>
        <Stack>
          <Text size="sm">{confirmDelete === 'orphans' ? '這些草稿無法確認屬於哪個帳號，清除後無法復原。' : '尚未同步的內容會永久消失，無法復原。'}確定要刪除嗎？</Text>
          <Group justify="flex-end"><Button variant="default" onClick={() => setConfirmDelete(null)}>取消</Button>
            <Button color="red" onClick={deleteDrafts} data-testid="drafts-delete-confirm">確定刪除</Button></Group>
        </Stack>
      </Modal>
    </Container>
  );
}
