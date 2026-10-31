'use client';
// 工作區外框（在頁面之間切換時保持不動）：左側頁面樹、上方頁面標題與儲存狀態
import { createContext, useCallback, useContext, useState } from 'react';
import { useParams } from 'next/navigation';
import { AppShell, Badge, Burger, Group, Text, Anchor } from '@mantine/core';
import { useDisclosure } from '@mantine/hooks';
import Sidebar, { type TreePage } from './Sidebar';
import type { SaveState } from './Editor';

// FR-10 的三種主要狀態用語：「已儲存」「儲存中」「離線，內容保存在此裝置」
const STATUS: Record<SaveState, { label: string; color: string }> = {
  loading: { label: '載入中', color: 'gray' },
  saved: { label: '已儲存', color: 'teal' },
  saving: { label: '儲存中', color: 'blue' },
  failed: { label: '離線，內容保存在此裝置', color: 'orange' },
  unsaved: { label: '尚未存到此裝置', color: 'red' },
  readonly: { label: '處理衝突中', color: 'orange' },
  blocked: { label: '有其他帳號的草稿', color: 'orange' },
  revoked: { label: '登入已失效', color: 'red' },
  page_closed: { label: '頁面已移到垃圾桶', color: 'gray' },
  error: { label: '錯誤：無法儲存', color: 'red' },
};

const StatusCtx = createContext<(s: SaveState) => void>(() => {});
export const useReportStatus = () => useContext(StatusCtx);

export default function WorkspaceShell({ children }: { children: React.ReactNode }) {
  const params = useParams<{ id?: string }>();
  const pageId = params?.id ? String(params.id).toLowerCase() : null;
  const [opened, { toggle, close }] = useDisclosure();
  const [status, setStatus] = useState<SaveState>('loading');
  const [current, setCurrent] = useState<TreePage | null>(null);
  const report = useCallback((s: SaveState) => setStatus(prev => (prev === s ? prev : s)), []);
  const st = STATUS[status];

  return (
    <StatusCtx.Provider value={report}>
      <AppShell header={{ height: 52 }} navbar={{ width: 280, breakpoint: 'sm', collapsed: { mobile: !opened } }} padding={0}>
        <AppShell.Header>
          <Group h="100%" px="md" justify="space-between" wrap="nowrap">
            <Group gap="sm" wrap="nowrap" style={{ minWidth: 0 }}>
              <Burger opened={opened} onClick={toggle} hiddenFrom="sm" size="sm" aria-label="開關頁面列表" />
              <Text fw={600} truncate data-testid="page-title">{pageId ? `${current?.icon ? current.icon + ' ' : ''}${current?.title || '未命名'}` : '工作區'}</Text>
            </Group>
            <Group gap="sm" wrap="nowrap">
              {pageId && <Badge variant="light" color={st.color} data-testid="save-status" data-state={status}>{st.label}</Badge>}
              <Anchor href="/settings" size="sm">設定</Anchor>
            </Group>
          </Group>
        </AppShell.Header>
        <AppShell.Navbar>
          <Sidebar currentId={pageId} onCurrent={setCurrent} onNavigate={close} />
        </AppShell.Navbar>
        <AppShell.Main>{children}</AppShell.Main>
      </AppShell>
    </StatusCtx.Provider>
  );
}
