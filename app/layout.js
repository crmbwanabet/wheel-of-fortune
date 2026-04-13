import { Inter } from "next/font/google";
import "./globals.css";

const inter = Inter({ subsets: ["latin"], weight: ["400", "600", "700", "800", "900"] });

export const metadata = {
  title: "Wheel of Fortune — BwanaBet",
  description: "Spin the wheel and win amazing prizes on BwanaBet!",
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body className={`${inter.className} antialiased`}>
        {children}
      </body>
    </html>
  );
}
