import { Outlet } from "react-router";

export function SetupLayout() {
  return (
    <main className="mx-auto min-h-screen max-w-5xl px-4 py-6">
      <Outlet />
    </main>
  );
}
