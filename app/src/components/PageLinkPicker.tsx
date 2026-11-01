'use client';
// 插入頁面連結時選擇目標頁面（M2 W1）：清單來自側邊欄的頁面樹（只含未刪除的頁面）
import { useEffect, useState } from 'react';
import { Modal, TextInput, UnstyledButton, Stack, Text } from '@mantine/core';
import { pageRegistry } from '@shared/page-registry.js';

export default function PageLinkPicker({ opened, onClose, onPick, exclude }: { opened: boolean; onClose: () => void; onPick: (id: string) => void; exclude?: string }) {
  const [q, setQ] = useState('');
  const [, bump] = useState(0);
  useEffect(() => pageRegistry.subscribe(() => bump(n => n + 1)), []);
  useEffect(() => { if (opened) setQ(''); }, [opened]);
  const items = (pageRegistry.list() as { id: string; title: string; icon: string | null }[])
    .filter(p => p.id !== exclude && (!q || (p.title || '未命名').toLowerCase().includes(q.toLowerCase())))
    .slice(0, 50);
  return (
    <Modal opened={opened} onClose={onClose} title="插入頁面連結" data-testid="page-link-picker">
      <TextInput placeholder="搜尋頁面標題" value={q} onChange={e => setQ(e.currentTarget.value)} data-autofocus mb="sm" />
      <Stack gap={2} mah={320} style={{ overflowY: 'auto' }}>
        {items.length === 0 && <Text c="dimmed" size="sm">沒有符合的頁面</Text>}
        {items.map(p => (
          <UnstyledButton key={p.id} data-page-id={p.id} onClick={() => onPick(p.id)} p={6} style={{ borderRadius: 4 }}>
            {(p.icon || '📄') + ' ' + (p.title || '未命名')}
          </UnstyledButton>
        ))}
      </Stack>
    </Modal>
  );
}
