import type { Metadata, Viewport } from 'next';
import { WorkerSetup } from './WorkerSetup';
import '@fontsource-variable/figtree';
import '@fontsource/ibm-plex-mono/400.css';
import '@fontsource/ibm-plex-mono/500.css';
import './globals.css';

export const metadata: Metadata = {
  title: 'zega · computer',
  description: 'Your computer, as a graph. Local by default.',
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  themeColor: '#f5f7f6',
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en"><body><WorkerSetup />{children}<script src="/desktop-auth.js" defer /></body></html>;
}
