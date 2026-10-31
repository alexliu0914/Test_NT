'use client';
// 頁面樹（FR-03）：建立、改名、設圖示、拖曳排序或移到其他頁面底下、移入垃圾桶、從垃圾桶還原。
// 另一位使用者的變更經 /api/pages/events 推送，2 秒內出現（PAGE-01）。
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { ActionIcon, Box, Button, Collapse, Group, Menu, Popover, ScrollArea, SimpleGrid, Stack, Text, TextInput, UnstyledButton } from '@mantine/core';

export type TreePage = { id: string; parentId: string | null; title: string; icon: string | null; position: string };
type RowCtx = {
  children: Map<string | null, TreePage[]>; expanded: Set<string>; setExpanded: React.Dispatch<React.SetStateAction<Set<string>>>;
  currentId: string | null; drop: { id: string; where: 'before' | 'inside' | 'after' } | null;
  setDrop: React.Dispatch<React.SetStateAction<{ id: string; where: 'before' | 'inside' | 'after' } | null>>;
  editing: string | null; setEditing: (id: string | null) => void;
  move: (id: string, target: TreePage, where: 'before' | 'inside' | 'after') => void;
  setIcon: (id: string, icon: string | null) => void; rename: (id: string, title: string) => void;
  create: (parentId: string | null) => void; remove: (id: string) => void; open: (id: string) => void;
};
type TrashItem = { id: string; title: string; icon: string | null; deletedAt: string; count: number };

const ICONS = ['📄', '📝', '📌', '📚', '🎧', '🎵', '💡', '✅', '📅', '⭐', '🏠', '💼', '🧪', '🗂️', '🔖', '🌱'];

async function api(path: string, method = 'GET', body?: unknown) {
  const r = await fetch(path, { method, cache: 'no-store', headers: body ? { 'content-type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => ({}));
  return { ok: r.ok, status: r.status, data: j };
}

export default function Sidebar({ currentId, onCurrent, onNavigate }: { currentId: string | null; onCurrent: (p: TreePage | null) => void; onNavigate: () => void }) {
  const router = useRouter();
  const [pages, setPages] = useState<TreePage[]>([]);
  const [trash, setTrash] = useState<TrashItem[]>([]);
  const [trashOpen, setTrashOpen] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(() => {
    try { return new Set(JSON.parse(localStorage.getItem('tree.expanded') || '[]')); } catch { return new Set(); }
  });
  const [editing, setEditing] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [drop, setDrop] = useState<{ id: string; where: 'before' | 'inside' | 'after' } | null>(null);

  const load = useCallback(async () => {
    const r = await api('/api/pages');
    if (r.status === 401) { router.replace('/login'); return; }
    if (r.ok) setPages(r.data.pages);
    const t = await api('/api/pages/trash');
    if (t.ok) setTrash(t.data.items);
  }, [router]);

  useEffect(() => {
    load();
    const es = new EventSource('/api/pages/events');
    es.addEventListener('changed', () => load());
    es.addEventListener('ready', () => load());
    return () => es.close();
  }, [load]);

  useEffect(() => { try { localStorage.setItem('tree.expanded', JSON.stringify([...expanded])); } catch { /* 無法使用 */ } }, [expanded]);

  const children = useMemo(() => {
    const m = new Map<string | null, TreePage[]>();
    for (const p of pages) { const k = p.parentId; if (!m.has(k)) m.set(k, []); m.get(k)!.push(p); }
    for (const list of m.values()) list.sort((a, b) => (a.position < b.position ? -1 : a.position > b.position ? 1 : a.id < b.id ? -1 : 1));
    return m;
  }, [pages]);

  const current = pages.find(p => p.id === currentId) || null;
  useEffect(() => { onCurrent(current); }, [current, onCurrent]);

  // 目前頁面的上層都展開
  useEffect(() => {
    if (!current) return;
    const byId = new Map(pages.map(p => [p.id, p]));
    const add: string[] = [];
    let p = current.parentId ? byId.get(current.parentId) : undefined;
    while (p) { add.push(p.id); p = p.parentId ? byId.get(p.parentId) : undefined; }
    if (add.some(id => !expanded.has(id))) setExpanded(s => new Set([...s, ...add]));
  }, [current, pages, expanded]);

  function fail(r: { data: { error?: { message?: string } } }) { setError(r.data?.error?.message || '操作失敗'); setTimeout(() => setError(null), 4000); }

  async function create(parentId: string | null) {
    const r = await api('/api/pages', 'POST', { parentId, title: '' });
    if (!r.ok) return fail(r);
    if (parentId) setExpanded(s => new Set([...s, parentId]));
    await load();
    setEditing(r.data.page.id);
    router.push(`/p/${r.data.page.id}`);
    onNavigate();
  }
  async function rename(id: string, title: string) {
    setEditing(null);
    const r = await api(`/api/pages/${id}`, 'PATCH', { title });
    if (!r.ok) fail(r);
    load();
  }
  async function setIcon(id: string, icon: string | null) {
    const r = await api(`/api/pages/${id}`, 'PATCH', { icon });
    if (!r.ok) fail(r);
    load();
  }
  async function remove(id: string) {
    const r = await api(`/api/pages/${id}`, 'DELETE');
    if (!r.ok) return fail(r);
    await load();
    if (id === currentId || isDescendant(currentId, id)) router.push('/');
  }
  async function restore(id: string) {
    const r = await api(`/api/pages/${id}/restore`, 'POST');
    if (!r.ok) return fail(r);
    await load();
  }
  function isDescendant(maybeChild: string | null, ancestor: string) {
    const byId = new Map(pages.map(p => [p.id, p]));
    let p = maybeChild ? byId.get(maybeChild) : undefined;
    while (p && p.parentId) { if (p.parentId === ancestor) return true; p = byId.get(p.parentId); }
    return false;
  }
  async function move(id: string, target: TreePage, where: 'before' | 'inside' | 'after') {
    setDrop(null);
    if (id === target.id) return;
    let body: { parentId: string | null; afterId?: string | null };
    if (where === 'inside') body = { parentId: target.id };
    else {
      const sibs = (children.get(target.parentId) || []).filter(p => p.id !== id);
      const i = sibs.findIndex(p => p.id === target.id);
      body = { parentId: target.parentId, afterId: where === 'after' ? target.id : (i > 0 ? sibs[i - 1].id : null) };
    }
    const r = await api(`/api/pages/${id}`, 'PATCH', body);
    if (!r.ok) fail(r);
    if (where === 'inside') setExpanded(s => new Set([...s, target.id]));
    load();
  }

  const ctx: RowCtx = { children, expanded, setExpanded, currentId, drop, setDrop, editing, setEditing, move, setIcon, rename, create, remove,
    open: (id: string) => { router.push(`/p/${id}`); onNavigate(); } };
  const roots = children.get(null) || [];
  return (
    <Stack gap={0} h="100%">
      <ScrollArea style={{ flex: 1 }} py="xs" data-testid="tree">
        {roots.map(p => <Row key={p.id} p={p} depth={0} ctx={ctx} />)}
        {roots.length === 0 && <Text size="sm" c="dimmed" px="md" py="sm">還沒有頁面</Text>}
      </ScrollArea>
      {error && <Text size="sm" c="red" px="md" py={4} role="alert">{error}</Text>}
      <Stack gap={4} p="sm" style={{ borderTop: '1px solid var(--mantine-color-default-border)' }}>
        <Button variant="subtle" justify="flex-start" onClick={() => create(null)}>＋ 新增頁面</Button>
        <Button variant="subtle" color="gray" justify="flex-start" onClick={() => setTrashOpen(o => !o)}>垃圾桶（{trash.length}）</Button>
        <Collapse expanded={trashOpen}>
          <Stack gap={2} mah={240} style={{ overflow: 'auto' }} data-testid="trash">
            <Text size="xs" c="dimmed" px={8}>刪除的頁面保留 30 天，之後永久刪除。</Text>
            {trash.map(t => (
              <Group key={t.id} gap={4} px={8} wrap="nowrap" justify="space-between">
                <Text size="sm" truncate>{t.icon || '📄'} {t.title || '未命名'}{t.count > 1 ? `（含 ${t.count - 1} 個子頁面）` : ''}</Text>
                <Button size="compact-xs" variant="light" onClick={() => restore(t.id)}>還原</Button>
              </Group>
            ))}
          </Stack>
        </Collapse>
      </Stack>
    </Stack>
  );
}

function Row({ p, depth, ctx }: { p: TreePage; depth: number; ctx: RowCtx }) {
const { children, expanded, setExpanded, currentId, drop, setDrop, editing, setEditing, move, setIcon, rename, create, remove } = ctx;
  const kids = children.get(p.id) || [];
  const open = expanded.has(p.id);
  const active = p.id === currentId;
  const marker = drop?.id === p.id ? drop.where : null;
  return (
    <Box>
      <Group gap={2} wrap="nowrap" pl={8 + depth * 14} pr={4} draggable data-page-id={p.id} data-testid="tree-row"
        onDragStart={e => { e.dataTransfer.setData('text/page-id', p.id); e.dataTransfer.effectAllowed = 'move'; }}
        onDragOver={e => {
          if (!e.dataTransfer.types.includes('text/page-id')) return;
          e.preventDefault();
          const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
          const y = (e.clientY - r.top) / r.height;
          const where = y < 0.25 ? 'before' : y > 0.75 ? 'after' : 'inside';
          if (drop?.id !== p.id || drop.where !== where) setDrop({ id: p.id, where });
        }}
        onDragLeave={() => setDrop(d => (d?.id === p.id ? null : d))}
        onDrop={e => { e.preventDefault(); const id = e.dataTransfer.getData('text/page-id'); if (id && marker) move(id, p, marker); }}
        style={{
          borderRadius: 6, minHeight: 30,
          background: active ? 'var(--mantine-color-default-hover)' : marker === 'inside' ? 'var(--mantine-color-teal-light)' : undefined,
          boxShadow: marker === 'before' ? 'inset 0 2px 0 var(--mantine-color-teal-6)' : marker === 'after' ? 'inset 0 -2px 0 var(--mantine-color-teal-6)' : undefined,
        }}>
        <ActionIcon variant="subtle" size="sm" color="gray" aria-label={open ? '收合' : '展開'} onClick={() => setExpanded(s => { const n = new Set(s); if (n.has(p.id)) n.delete(p.id); else n.add(p.id); return n; })}
          style={{ visibility: kids.length ? 'visible' : 'hidden' }}>{open ? '▾' : '▸'}</ActionIcon>
        <Popover position="bottom-start" withArrow shadow="md">
          <Popover.Target><ActionIcon variant="subtle" size="sm" color="gray" aria-label="設定圖示">{p.icon || '📄'}</ActionIcon></Popover.Target>
          <Popover.Dropdown>
            <SimpleGrid cols={8} spacing={2}>{ICONS.map(i => <ActionIcon key={i} variant="subtle" onClick={() => setIcon(p.id, i)} aria-label={'圖示 ' + i}>{i}</ActionIcon>)}</SimpleGrid>
            <Button size="compact-xs" variant="subtle" mt={6} onClick={() => setIcon(p.id, null)}>移除圖示</Button>
          </Popover.Dropdown>
        </Popover>
        {editing === p.id ? (
          <TextInput size="xs" autoFocus defaultValue={p.title} aria-label="頁面名稱" style={{ flex: 1 }}
            onBlur={e => rename(p.id, e.currentTarget.value)}
            onKeyDown={e => { if (e.key === 'Enter') (e.currentTarget as HTMLInputElement).blur(); if (e.key === 'Escape') setEditing(null); }} />
        ) : (
          <UnstyledButton style={{ flex: 1, minWidth: 0 }} onClick={() => ctx.open(p.id)} onDoubleClick={() => setEditing(p.id)}>
            <Text size="sm" truncate c={p.title ? undefined : 'dimmed'}>{p.title || '未命名'}</Text>
          </UnstyledButton>
        )}
        <Menu position="bottom-end" withinPortal>
          <Menu.Target><ActionIcon variant="subtle" size="sm" color="gray" aria-label="頁面選項">⋯</ActionIcon></Menu.Target>
          <Menu.Dropdown>
            <Menu.Item onClick={() => create(p.id)}>新增子頁面</Menu.Item>
            <Menu.Item onClick={() => setEditing(p.id)}>重新命名</Menu.Item>
            <Menu.Divider />
            <Menu.Item color="red" onClick={() => remove(p.id)}>移到垃圾桶</Menu.Item>
          </Menu.Dropdown>
        </Menu>
      </Group>
      {open && kids.map(k => <Row key={k.id} p={k} depth={depth + 1} ctx={ctx} />)}
    </Box>
  );
}

