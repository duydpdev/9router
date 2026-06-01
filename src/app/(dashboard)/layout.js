import { DashboardLayout } from "@/shared/components";

// Keep the private dashboard out of search indexes (polite layer; hard UA
// blocking lives in the bot guard). Merges over the root metadata.
export const metadata = {
  robots: { index: false, follow: false },
};

export default function DashboardRootLayout({ children }) {
  return <DashboardLayout>{children}</DashboardLayout>;
}

