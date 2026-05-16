import './globals.css';

export const metadata = {
  title: 'BlvckLink',
  description: 'Personal WhatsApp automation powered by BlvckBot',
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
