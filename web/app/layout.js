import { Montserrat } from 'next/font/google';
import './globals.css';

// Same typeface as fairflai.com: regular for text, bold for labels, extra-bold italic for the title
const montserrat = Montserrat({ subsets: ['latin'], weight: ['400', '700', '800'], style: ['normal', 'italic'] });

export const metadata = { title: 'SimultanAI', icons: { icon: '/logo.avif' } };

export default function RootLayout({ children }) {
  return (
    <html lang="en" className={montserrat.className}>
      <body>{children}</body>
    </html>
  );
}
