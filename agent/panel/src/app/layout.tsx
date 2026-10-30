import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Website assistant',
  description: 'Change your AnyPress website in plain words.',
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" className="h-full antialiased">
      <body className="flex h-full min-h-0 flex-col bg-background font-sans text-foreground">{children}</body>
    </html>
  );
}
