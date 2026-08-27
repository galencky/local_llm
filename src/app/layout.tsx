import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";

const geistSans = Geist({ variable: "--font-geist-sans", subsets: ["latin"] });
const geistMono = Geist_Mono({ variable: "--font-geist-mono", subsets: ["latin"] });

export const metadata: Metadata = {
  title: "Project Airlock",
  description:
    "A local AI strips patient identity before anything reaches the cloud. PDPA-compliant clinical note structuring with end-to-end encrypted transport.",
  applicationName: "Project Airlock",
  authors: [{ name: "Kuan-Yuan Chen" }, { name: "Claude Code" }],
  creator: "Kuan-Yuan Chen",
  robots: { index: false, follow: false },
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="en"
      suppressHydrationWarning
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <head>
        {/*
          Apply the stored theme before first paint. Without this the page
          renders in the OS theme and then snaps — a white flash on a night
          shift is worse than the inline script.
        */}
        <script
          dangerouslySetInnerHTML={{
            __html: `(function(){try{var t=localStorage.getItem('airlock-theme');if(t==='light'||t==='dark'){document.documentElement.setAttribute('data-theme',t);}}catch(e){}})();`,
          }}
        />
      </head>
      {/* `lg:h-full` makes the height DEFINITE on a desktop, which is what
          lets `flex-1` distribute space instead of every panel sizing itself
          to its own content. Small screens keep `min-h-full` and scroll. */}
      <body className="flex min-h-full flex-col lg:h-full">{children}</body>
    </html>
  );
}
