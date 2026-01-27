import React from "react";
import { DashboardLayoutSkeleton } from './DashboardLayoutSkeleton';
import { useAuth } from "@/_core/hooks/useAuth";

export default function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const { loading } = useAuth();

  if (loading) {
    return <DashboardLayoutSkeleton />
  }

  return (
    <div className="min-h-screen bg-background">
      <main className="w-full h-full">{children}</main>
    </div>
  );
}
