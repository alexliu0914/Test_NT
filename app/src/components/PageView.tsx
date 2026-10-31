'use client';
import dynamic from 'next/dynamic';
import { useReportStatus } from './WorkspaceShell';

const Editor = dynamic(() => import('./Editor'), { ssr: false });

export default function PageView({ pageId, user }: { pageId: string; user: { id: string; name: string } }) {
  const report = useReportStatus();
  return (
    <div style={{ paddingBlock: 24 }}>
      <Editor key={pageId} pageId={pageId} user={user} onStatus={report} />
    </div>
  );
}
