'use client';
// 版本紀錄（M2-c W4）：手動「存一版」、版本清單（自動／手動／還原前，附到期日）、唯讀預覽、還原與再次還原、還原紀錄、衝突副本的唯讀預覽與複製。
// 讀取走 /api/pages/:id/versions（只讀、經安全轉換的區塊 JSON）；存版與還原只走既有協作連線（D2，沒有 REST 寫入端點）。
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Badge, Button, Drawer, Group, Modal, ScrollArea, Stack, Text, UnstyledButton, useComputedColorScheme } from '@mantine/core';
import { BlockNoteEditor } from '@blocknote/core';
import { BlockNoteView } from '@blocknote/mantine';
import type { Client } from '@shared/client.js';
import { schema } from '@shared/blocknote-schema.js';
import { dictionary } from '@shared/editor-dictionary.js';
import { isSafeHref } from '@shared/link-policy.js';

type Version = { id: string; reason: string; source: string; createdAt: string; expiresAt: string; author: string | null };
type Restore = { id: string; appliedAt: string | null; by: string | null; targetVersionId: string | null; targetReason: string | null; targetCreatedAt: string | null; beforeVersionId: string | null };
type Conflict = { id: string; createdAt: string; author: string | null };
type Listing = { versions: Version[]; restores: Restore[]; conflicts: Conflict[]; retentionDays: number };
type Preview = { kind: 'version' | 'conflict'; id: string; label: string; blocks: unknown[] };

const fmt = (iso: string | null) => (iso ? new Date(iso).toLocaleString('zh-TW', { hour12: false }) : '');
export function versionLabel(v: { reason: string | null; source?: string | null }) {
  if (v.reason === 'manual') return '手動';
  if (v.reason === 'before_restore') return '還原前';
  if (v.reason === 'auto' && v.source === 'schedule') return '自動';
  return '存版';
}
const RESTORE_MSG: Record<string, string> = {
  applied: '已還原到所選版本。',
  already_applied: '這次還原已經套用過。',
  no_such_version: '此版本已超過保留期限（90 天）而被清除，無法還原。',
  restore_id_conflict: '還原失敗，請重新整理後再試。',
};

export default function VersionPanel({ client, pageId, opened, onClose, onMessage }: {
  client: InstanceType<typeof Client>; pageId: string; opened: boolean; onClose: () => void; onMessage: (msg: string) => void;
}) {
  const [list, setList] = useState<Listing | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [confirm, setConfirm] = useState<Version | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    const r = await fetch(`/api/pages/${pageId}/versions`, { cache: 'no-store' });
    if (!r.ok) { setError('無法讀取版本紀錄。'); return; }
    setList(await r.json());
  }, [pageId]);
  useEffect(() => { if (opened) load(); }, [opened, load]);

  async function show(kind: 'version' | 'conflict', id: string, label: string) {
    const r = await fetch(`/api/pages/${pageId}/${kind === 'version' ? 'versions' : 'conflicts'}/${encodeURIComponent(id)}`, { cache: 'no-store' });
    if (!r.ok) { setError(r.status === 404 ? '此版本已不存在（可能已超過保留期限）。' : '無法讀取版本內容。'); load(); return; }
    const j = await r.json();
    setPreview({ kind, id, label, blocks: j.blocks });
  }

  async function doRestore(v: Version) {
    setBusy(true);
    try {
      const restoreId = client.restore(v.id);
      const res = await new Promise<{ status: string }>(resolve => {
        const h = (m: { restoreId: string; status: string }) => { if (m.restoreId === restoreId) { client.off('restore_result', h); resolve(m); } };
        client.on('restore_result', h);
      });
      onMessage(RESTORE_MSG[res.status] || '還原失敗：' + res.status);
      setConfirm(null); setPreview(null);
      await load();
    } finally { setBusy(false); }
  }

  return (
    <Drawer opened={opened} onClose={onClose} position="right" size="lg" title="版本紀錄" data-testid="version-panel">
      {error && <Text c="red" size="sm" role="alert" data-testid="version-error">{error}</Text>}
      {!list ? <Text size="sm" c="dimmed">載入中…</Text> : (
        <Stack gap="md">
          <Text size="xs" c="dimmed">有修改時每 10 分鐘自動存一版；所有版本保留 {list.retentionDays} 天。</Text>
          <Stack gap={4}>
            <Text fw={600} size="sm">版本</Text>
            {list.versions.length === 0 && <Text size="sm" c="dimmed">還沒有版本。</Text>}
            {list.versions.map(v => (
              <UnstyledButton key={v.id} data-testid="version-row" data-version-id={v.id} data-kind={versionLabel(v)} onClick={() => show('version', v.id, `${versionLabel(v)}・${fmt(v.createdAt)}`)}
                style={{ padding: '6px 8px', borderRadius: 4, background: preview && preview.id === v.id ? 'var(--mantine-color-default-hover)' : undefined }}>
                <Group gap="xs" wrap="nowrap">
                  <Badge size="sm" variant="light" color={v.reason === 'manual' ? 'blue' : v.reason === 'before_restore' ? 'orange' : 'gray'}>{versionLabel(v)}</Badge>
                  <Text size="sm">{fmt(v.createdAt)}</Text>
                  {v.author && <Text size="xs" c="dimmed">{v.author}</Text>}
                  <Text size="xs" c="dimmed" ml="auto">保留至 {new Date(v.expiresAt).toLocaleDateString('zh-TW')}</Text>
                </Group>
              </UnstyledButton>
            ))}
          </Stack>
          {list.restores.length > 0 && (
            <Stack gap={4}>
              <Text fw={600} size="sm">還原紀錄</Text>
              {list.restores.map(r => (
                <Text key={r.id} size="sm" data-testid="restore-row" data-target={r.targetVersionId || ''}>
                  {fmt(r.appliedAt)}　{r.by || '有人'}還原到 {r.targetReason ? versionLabel({ reason: r.targetReason }) : ''}（{fmt(r.targetCreatedAt)}）
                  {!r.targetVersionId && <Text span c="dimmed" size="xs">　該版本已超過保留期限</Text>}
                </Text>
              ))}
            </Stack>
          )}
          {list.conflicts.length > 0 && (
            <Stack gap={4}>
              <Text fw={600} size="sm">衝突副本</Text>
              <Text size="xs" c="dimmed">還原時尚未同步的修改，只能檢視與複製，不會自動放回文件。</Text>
              {list.conflicts.map(c => (
                <UnstyledButton key={c.id} data-testid="conflict-row" data-copy-id={c.id} onClick={() => show('conflict', c.id, `衝突副本・${fmt(c.createdAt)}`)} style={{ padding: '6px 8px' }}>
                  <Group gap="xs"><Badge size="sm" color="red" variant="light">衝突副本</Badge><Text size="sm">{fmt(c.createdAt)}</Text>{c.author && <Text size="xs" c="dimmed">{c.author}</Text>}</Group>
                </UnstyledButton>
              ))}
            </Stack>
          )}
          {preview && (
            <Stack gap="xs" data-testid="version-preview" data-preview-id={preview.id}>
              <Group justify="space-between">
                <Text fw={600} size="sm">預覽（唯讀）：{preview.label}</Text>
                {preview.kind === 'version'
                  ? <Button size="xs" data-testid="restore-button" onClick={() => setConfirm(list.versions.find(v => v.id === preview.id) || null)}>還原到此版本</Button>
                  : <CopyBlocks blocks={preview.blocks} />}
              </Group>
              <ScrollArea.Autosize mah={420} style={{ border: '1px solid var(--mantine-color-default-border)', borderRadius: 4 }}>
                <ReadOnlyBlocks key={preview.id} blocks={preview.blocks} />
              </ScrollArea.Autosize>
            </Stack>
          )}
        </Stack>
      )}
      <Modal opened={!!confirm} onClose={() => setConfirm(null)} title="還原版本" data-testid="restore-confirm">
        <Stack>
          <Text size="sm">會將目前文件恢復到所選版本（{confirm ? `${versionLabel(confirm)}・${fmt(confirm.createdAt)}` : ''}）；未同步內容可能移入衝突副本。目前的內容會另存為「還原前」版本，可以再還原回來。</Text>
          <Group justify="flex-end">
            <Button variant="default" onClick={() => setConfirm(null)}>取消</Button>
            <Button data-testid="restore-confirm-button" loading={busy} onClick={() => confirm && doRestore(confirm)}>還原</Button>
          </Group>
        </Stack>
      </Modal>
    </Drawer>
  );
}

// 唯讀預覽：不連接協作文件的獨立編輯器（不能編輯），連結同樣套用 isSafeHref
function ReadOnlyBlocks({ blocks }: { blocks: unknown[] }) {
  const scheme = useComputedColorScheme('light');
  const editor = useMemo(() => BlockNoteEditor.create({
    schema, dictionary, links: { isValidLink: isSafeHref },
    initialContent: (blocks && blocks.length ? blocks : undefined) as never,
  }), [blocks]);
  return <BlockNoteView editor={editor} editable={false} theme={scheme === 'dark' ? 'dark' : 'light'} slashMenu={false} formattingToolbar={false} sideMenu={false} />;
}

function CopyBlocks({ blocks }: { blocks: unknown[] }) {
  const [done, setDone] = useState(false);
  async function copy() {
    const ed = BlockNoteEditor.create({ schema, initialContent: (blocks.length ? blocks : undefined) as never });
    const md = await ed.blocksToMarkdownLossy(ed.document);
    await navigator.clipboard.writeText(md).catch(() => {});
    setDone(true);
  }
  return <Button size="xs" variant="default" data-testid="copy-conflict" onClick={copy}>{done ? '已複製' : '複製內容'}</Button>;
}
