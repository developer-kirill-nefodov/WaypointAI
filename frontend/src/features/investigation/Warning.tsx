import { TriangleAlert } from "lucide-react";
import type { ReactNode } from "react";

/** Amber notice for data the user should not read as ordinary results (synthetic, unverified, stale). */
export default function Warning({ children }: { children: ReactNode }) {
  return (
    <p className="investigation-warning">
      <TriangleAlert size={13} />
      {children}
    </p>
  );
}
