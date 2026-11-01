'use client';
// 共享空間的對話框（M2-s，FR-20）：新增共享空間、空間設定（建立者：改名、加入與移除成員、刪除；成員：退出）、跨空間移動確認
import { useEffect, useState } from 'react';
import { Button, Group, Modal, Select, Stack, Text, TextInput } from '@mantine/core';

export type SpaceMember = { id: string; name: string; email: string; role: 'owner' | 'member' };
export type Space = { id: string; kind: 'personal' | 'shared'; name: string; ownerId: string; members: SpaceMember[] };
type User = { id: string; name: string; email: string };
type SpaceRef = { id: string; name: string; kind: string };
export type MovePreview = {
  page: { id: string; title: string }; from: SpaceRef; to: SpaceRef;
  gained: User[]; lost: User[]; kept: User[]; count: number; descendants: number; confirm: string;
};

async function api(path: string, method = 'GET', body?: unknown) {
  const r = await fetch(path, { method, cache: 'no-store', headers: body ? { 'content-type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => ({}));
  return { ok: r.ok, status: r.status, data: j };
}

const names = (us: User[]) => us.map(u => u.name || u.email).join('、');
const spaceLabel = (s: SpaceRef) => (s.kind === 'personal' ? '我的頁面' : s.name);

export default function SpaceDialogs({ me, spaces, settingsFor, onCloseSettings, creating, onCloseCreate, onChanged, onError }: {
  me: string; spaces: Space[]; settingsFor: string | null; onCloseSettings: () => void; creating: boolean; onCloseCreate: () => void;
  onChanged: () => void; onError: (msg: string) => void;
}) {
  return (
    <>
      <CreateSpace opened={creating} onClose={onCloseCreate} onChanged={onChanged} />
      <SpaceSettings me={me} space={spaces.find(s => s.id === settingsFor) || null} onClose={onCloseSettings} onChanged={onChanged} onError={onError} />
    </>
  );
}

function CreateSpace({ opened, onClose, onChanged }: { opened: boolean; onClose: () => void; onChanged: () => void }) {
  const [name, setName] = useState('');
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => { if (opened) { setName(''); setErr(null); } }, [opened]);
  async function submit() {
    const r = await api('/api/spaces', 'POST', { name });
    if (!r.ok) { setErr(r.data?.error?.message || '建立失敗'); return; }
    onChanged();
    onClose();
  }
  return (
    <Modal opened={opened} onClose={onClose} title="新增共享空間">
      <Stack>
        <Text size="sm" c="dimmed">共享空間只有你邀請的成員看得到，成員都可以編輯。建立後在空間設定中加入成員。</Text>
        <TextInput label="空間名稱" id="space-name" value={name} onChange={e => setName(e.currentTarget.value)} data-autofocus
          onKeyDown={e => { if (e.key === 'Enter') submit(); }} />
        {err && <Text c="red" size="sm" role="alert">{err}</Text>}
        <Group justify="flex-end"><Button onClick={submit}>建立</Button></Group>
      </Stack>
    </Modal>
  );
}

function SpaceSettings({ me, space, onClose, onChanged, onError }: { me: string; space: Space | null; onClose: () => void; onChanged: () => void; onError: (m: string) => void }) {
  const [users, setUsers] = useState<User[]>([]);
  const [name, setName] = useState('');
  const [adding, setAdding] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    if (!space) return;
    setName(space.name); setConfirmDelete(false); setErr(null); setAdding(null);
    api('/api/users').then(r => { if (r.ok) setUsers(r.data.users); });
  }, [space?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!space) return null;
  const owner = me === space.ownerId;
  const memberIds = new Set(space.members.map(m => m.id));
  const candidates = users.filter(u => !memberIds.has(u.id));
  const done = async (r: { ok: boolean; data: { error?: { message?: string } } }, close = false) => {
    if (!r.ok) { setErr(r.data?.error?.message || '操作失敗'); return false; }
    setErr(null); onChanged(); if (close) onClose();
    return true;
  };
  return (
    <Modal opened onClose={onClose} title={`空間設定：${space.name}`} data-testid="space-settings">
      <Stack>
        {owner && (
          <Group align="flex-end" wrap="nowrap">
            <TextInput label="空間名稱" id="space-rename" value={name} onChange={e => setName(e.currentTarget.value)} style={{ flex: 1 }} />
            <Button variant="light" onClick={async () => done(await api(`/api/spaces/${space.id}`, 'PATCH', { name }))}>改名</Button>
          </Group>
        )}
        <Text fw={600} size="sm">成員（{space.members.length} 人）</Text>
        <Stack gap={4} data-testid="space-members">
          {space.members.map(m => (
            <Group key={m.id} justify="space-between" wrap="nowrap" data-member-id={m.id}>
              <Text size="sm" truncate>{m.name}　<Text span c="dimmed" size="xs">{m.email}</Text>{m.role === 'owner' ? '（建立者）' : ''}</Text>
              {owner && m.role !== 'owner' && (
                <Button size="compact-xs" variant="subtle" color="red" aria-label={`移除 ${m.name}`}
                  onClick={async () => done(await api(`/api/spaces/${space.id}/members/${encodeURIComponent(m.id)}`, 'DELETE'))}>移除</Button>
              )}
            </Group>
          ))}
        </Stack>
        {owner && (
          <Group align="flex-end" wrap="nowrap">
            <Select label="加入成員" placeholder={candidates.length ? '選擇帳號' : '所有帳號都已是成員'} data-testid="add-member" id="add-member"
              data={candidates.map(u => ({ value: u.id, label: `${u.name}（${u.email}）` }))} value={adding} onChange={setAdding}
              disabled={!candidates.length} style={{ flex: 1 }} comboboxProps={{ withinPortal: false }} />
            <Button disabled={!adding} onClick={async () => { if (await done(await api(`/api/spaces/${space.id}/members`, 'POST', { userId: adding }))) setAdding(null); }}>加入</Button>
          </Group>
        )}
        {err && <Text c="red" size="sm" role="alert">{err}</Text>}
        {owner ? (
          !confirmDelete
            ? <Button variant="subtle" color="red" onClick={() => setConfirmDelete(true)}>刪除空間</Button>
            : <Stack gap={4}>
              <Text size="sm">刪除後，空間內的頁面會移到你的「我的頁面」垃圾桶（30 天內可還原，還原後只有你看得到）；其他成員立即失去存取權。</Text>
              <Group><Button color="red" onClick={async () => { const r = await api(`/api/spaces/${space.id}`, 'DELETE'); if (!r.ok) onError(r.data?.error?.message || '刪除失敗'); await done(r, true); }}>確定刪除</Button>
                <Button variant="default" onClick={() => setConfirmDelete(false)}>取消</Button></Group>
            </Stack>
        ) : (
          <Button variant="subtle" color="red" onClick={async () => done(await api(`/api/spaces/${space.id}/leave`, 'POST'), true)}>退出空間</Button>
        )}
      </Stack>
    </Modal>
  );
}

// 跨空間移動確認（P0-02）：「移到「X」後，A、B 會看到；C 將看不到（含 n 個子頁面）」
export function MoveConfirm({ move, onCancel, onConfirm }: { move: { preview: MovePreview } | null; onCancel: () => void; onConfirm: () => void }) {
  if (!move) return null;
  const p = move.preview;
  const see = [...p.kept, ...p.gained];
  return (
    <Modal opened onClose={onCancel} title="移到其他空間" data-testid="move-confirm">
      <Stack>
        <Text size="sm" data-testid="move-summary">
          移到「{spaceLabel(p.to)}」後，{see.length ? `${names(see)} 會看到` : '只有你看得到'}
          {p.lost.length ? `；${names(p.lost)} 將看不到` : ''}
          {p.descendants > 0 ? `（含 ${p.descendants} 個子頁面）` : ''}。
        </Text>
        {p.lost.length > 0 && <Text size="xs" c="dimmed">看不到的人正在開啟的頁面會立即中斷；他們尚未同步的內容只保留在他們的裝置上。</Text>}
        <Group justify="flex-end">
          <Button variant="default" onClick={onCancel}>取消</Button>
          <Button onClick={onConfirm}>確認移動</Button>
        </Group>
      </Stack>
    </Modal>
  );
}
