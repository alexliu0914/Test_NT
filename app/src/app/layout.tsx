import type { Metadata } from 'next';
import '@mantine/core/styles.css';
import './globals.css';
import { ColorSchemeScript, MantineProvider, mantineHtmlProps } from '@mantine/core';

export const metadata: Metadata = { title: '筆記', robots: { index: false, follow: false } };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-Hant" {...mantineHtmlProps}>
      <head><ColorSchemeScript defaultColorScheme="auto" /></head>
      <body>
        <MantineProvider defaultColorScheme="auto" theme={{ primaryColor: 'teal', defaultRadius: 'md', fontFamily: 'system-ui, -apple-system, "PingFang TC", "Noto Sans TC", "Microsoft JhengHei", sans-serif' }}>
          {children}
        </MantineProvider>
      </body>
    </html>
  );
}
