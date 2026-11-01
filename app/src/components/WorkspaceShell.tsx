'use client';
// 工作區外框（在頁面之間切換時保持不動）：左側頁面樹、上方頁面標題與儲存狀態
import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { useParams } from 'next/navigation';
import { AppShell, Badge, Burger, Button, Group, Modal, Stack, Text, Anchor } from '@mantine/core';
import { setLeaveAsker } from '@/lib/leave-guard';
import { useDisclosure } from '@mantine/hooks';
import Sidebar, { type TreePage } from './Sidebar';
import type { SaveState } from './Editor';

// FR-10 的五種儲存狀態（M2-b W3，判定規則見 shared/save-state.js）：已儲存、儲存中、離線，內容保存在此裝置、儲存失敗、尚未存到此裝置
const STATUS: Record<SaveState, { label: string; color: string }> = {
  loading: { label: '載入中', color: 'gray' },
  saved: { label: '已儲存', color: 'teal' },
  saving: { label: '儲存中', color: 'blue' },
  offline: { label: '離線，內容保存在此裝置', color: 'orange' },
  failed: { label: '儲存失敗', color: 'red' },
  unsaved: { label: '尚未存到此裝置', color: 'red' },
  readonly: { label: '處理衝突中', color: 'orange' },
  blocked: { label: '有其他帳號的草稿', color: 'orange' },
  revoked: { label: '登入已失效', color: 'red' },
  page_closed: { label: '無法開啟這個頁面', color: 'gray' },
  denied: { label: '已無法存取', color: 'red' },
  error: { label: '錯誤：無法儲存', color: 'red' },
};

const StatusCtx = createContext<(s: SaveState) => void>(() => {});
export const useReportStatus = () => useContext(StatusCtx);

export default function WorkspaceShell({ children, userId }: { children: React.ReactNode; userId: string }) {
  const params = useParams<{ id?: string }>();
  const pageId = params?.id ? String(params.id).toLowerCase() : null;
  const [opened, { toggle, close }] = useDisclosure();
  const [status, setStatus] = useState<SaveState>('loading');
  const [current, setCurrent] = useState<TreePage | null>(null);
  const report = useCallback((s: SaveState) => setStatus(prev => (prev === s ? prev : s)), []);
  const st = STATUS[status];
  // 切換頁面時目前頁面仍有尚未同步的修改：詢問是否離開（M2-b W3）
  const [leave, setLeave] = useState<number | null>(null);
  const answer = useRef<((ok: boolean) => void) | null>(null);
  useEffect(() => {
    setLeaveAsker(n => new Promise<boolean>(res => { answer.current = res; setLeave(n); }));
    return () => setLeaveAsker(null);
  }, []);
  const reply = (ok: boolean) => { setLeave(null); const a = answer.current; answer.current = null; if (a) a(ok); };

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
          <Sidebar currentId={pageId} userId={userId} onCurrent={setCurrent} onNavigate={close} />
        </AppShell.Navbar>
        <AppShell.Main>{children}</AppShell.Main>
      </AppShell>
      <Modal opened={leave !== null} onClose={() => reply(false)} title="這一頁還有尚未同步的修改">
        <Stack>
          <Text size="sm" data-testid="leave-confirm">有 {leave} 筆修改還沒有存到伺服器。內容已保存在此裝置，下次開啟這一頁時會再送出；在那之前其他人看不到這些修改。</Text>
          <Group justify="flex-end">
            <Button variant="default" onClick={() => reply(false)}>留在此頁</Button>
            <Button color="orange" onClick={() => reply(true)}>仍要離開</Button>
          </Group>
        </Stack>
      </Modal>
    </StatusCtx.Provider>
  );
}
