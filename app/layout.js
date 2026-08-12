import { Roboto_Condensed } from "next/font/google";
import "./globals.css";

// Matches bwanabet.com, which sets `"Roboto Condensed", sans-serif` on body and
// uses 400/700 throughout. The widget previously shipped Inter, so its type read
// as a different product bolted onto the site. 900 is included for headlines,
// buttons and the wheel labels.
//
// Condensed also earns its place on the wheel itself: "TRY AGAIN TOMORROW" has
// to fit inside a 36-degree segment, and a narrow face buys that room.
const brand = Roboto_Condensed({
  subsets: ["latin"],
  weight: ["400", "700", "900"],
  variable: "--font-brand",
  display: "swap",
});

export const metadata = {
  title: "Wheel of Fortune — BwanaBet",
  description: "Spin the wheel and win amazing prizes on BwanaBet!",
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body className={`${brand.variable} ${brand.className} antialiased`}>
        {children}
      </body>
    </html>
  );
}
