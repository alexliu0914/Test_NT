// Next.js 設定：安全標頭（CSP 等）在這裡統一加上
// 開發模式（next dev）的 React 需要 eval() 重建錯誤的呼叫堆疊，只在開發模式允許 'unsafe-eval'；
// 正式模式（next build／next start，測試與部署都用這個）的 CSP 不變。
const dev = process.env.NODE_ENV === 'development';
const csp = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline'${dev ? " 'unsafe-eval'" : ''}`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "media-src 'self' blob:",
  "font-src 'self' data:",
  `connect-src 'self' ${process.env.COLLAB_PUBLIC_URL || ''}`.trim(),
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "object-src 'none'",
].join('; ');

/** @type {import('next').NextConfig} */
const nextConfig = {
  poweredByHeader: false,
  reactStrictMode: true,
  // yjs、@blocknote/core 與 server-util 都由 Node 載入同一份（M2-c 版本預覽在伺服器端轉換區塊；打包一份、外部一份會有兩個 Yjs）
  serverExternalPackages: ['pg', 'jsdom', '@blocknote/server-util', '@blocknote/core', 'yjs'],
  async headers() {
    return [{
      source: '/:path*',
      headers: [
        { key: 'Content-Security-Policy', value: csp },
        { key: 'X-Content-Type-Options', value: 'nosniff' },
        { key: 'Referrer-Policy', value: 'same-origin' },
        { key: 'X-Frame-Options', value: 'DENY' },
        { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
      ],
    }];
  },
};
export default nextConfig;
