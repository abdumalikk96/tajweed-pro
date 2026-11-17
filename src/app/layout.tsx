import type { Metadata } from 'next';
import { Amiri, Inter } from 'next/font/google';
import './globals.css';

const inter = Inter({
  subsets: ['latin', 'cyrillic'],
  variable: '--font-inter',
  display: 'swap',
});

const amiri = Amiri({
  subsets: ['arabic'],
  weight: ['400', '700'],
  variable: '--font-amiri',
  display: 'swap',
});

export const metadata: Metadata = {
  title: 'Tajweed Pro — Qur\'on Tilovati & Tajvid AI Trenajori',
  description:
    'Tajweed Pro: Professional akustik va fonemik sun\'iy intellekt asosidagi Tajvid, Talaffuz (maxorij va sifatlar) hamda Qiroat trenajori',
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="ru" className={`${inter.variable} ${amiri.variable} dark`}>
      <body className="font-sans antialiased bg-[#12161F] text-slate-100 selection:bg-emerald-500/30 selection:text-emerald-200">
        {children}
      </body>
    </html>
  );
}
