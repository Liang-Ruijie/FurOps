import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'FurOps · 猫舍 AI 管家',
  description: '一句话/语音/照片 → 入档 → 成本联动 → 待办批阅',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-CN">
      {/* Browser extensions add body attributes before hydration; scope tolerance to this element only. */}
      <body suppressHydrationWarning>{children}</body>
    </html>
  );
}
